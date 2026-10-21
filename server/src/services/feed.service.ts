import { db } from '../config/db';
import { ApiError } from '../utils/apiError';
import { postInclude, serializePost } from './serializers';
import { getHiddenUserIds } from './user.service';

const PAGE = 20;

function paginate<T extends { id: string }>(items: T[], limit: number) {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

// Home timeline: top-level posts and reposts from the people the viewer
// follows (plus their own), newest first. Replies are excluded (seen in threads).
export async function getHomeFeed(viewerId: string, cursor?: string, limit = PAGE) {
  const [following, hidden] = await Promise.all([
    db.follow.findMany({ where: { followerId: viewerId }, select: { followingId: true } }),
    getHiddenUserIds(viewerId),
  ]);
  const authorIds = [viewerId, ...following.map((f) => f.followingId)].filter((id) => !hidden.includes(id));

  const where: any = {
    authorId: { in: authorIds },
    parentId: null, // exclude replies from the home timeline
    communityId: null, // community posts live in their own feed
  };

  const items = await db.post.findMany({
    where,
    include: postInclude(viewerId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const { page, nextCursor } = paginate(items, limit);
  return { items: page.map(serializePost), nextCursor };
}

// "For you" / Explore: a lightweight ranking over recent public posts.
// Score blends engagement with recency so fresh, popular posts surface first.
// Uses offset pagination because ordering is computed in memory.
export async function getExploreFeed(viewerId: string | undefined, page = 0, limit = PAGE) {
  const hidden = viewerId ? await getHiddenUserIds(viewerId) : [];
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Pull a candidate window of recent original posts, then rank in memory.
  const candidates = await db.post.findMany({
    where: {
      createdAt: { gte: since },
      parentId: null,
      repostOfId: null,
      communityId: null,
      ...(hidden.length ? { authorId: { notIn: hidden } } : {}),
    },
    include: postInclude(viewerId),
    orderBy: { createdAt: 'desc' },
    take: 300,
  });

  const now = Date.now();
  const scored = candidates
    .map((p: any) => {
      const ageHours = (now - new Date(p.createdAt).getTime()) / 3_600_000;
      const engagement =
        p._count.likes * 1 + p._count.reposts * 2 + p._count.replies * 1.5 + p._count.quotes * 1.5;
      // Time decay similar to Hacker News' gravity formula.
      const score = (engagement + 1) / Math.pow(ageHours + 2, 1.5);
      return { post: p, score };
    })
    .sort((a, b) => b.score - a.score);

  const start = page * limit;
  const slice = scored.slice(start, start + limit + 1);
  const hasMore = slice.length > limit;
  const items = (hasMore ? slice.slice(0, limit) : slice).map((s) => serializePost(s.post));
  return { items, nextPage: hasMore ? page + 1 : null };
}

export type ProfileTab = 'posts' | 'replies' | 'media' | 'likes';

// Posts shown on a user's profile, depending on the active tab.
export async function getUserPosts(
  username: string,
  tab: ProfileTab,
  viewerId?: string,
  cursor?: string,
  limit = PAGE,
) {
  const user = await db.user.findUnique({
    where: { username },
    select: { id: true, pinnedPostId: true },
  });
  if (!user) throw ApiError.notFound('User not found');

  if (tab === 'likes') {
    const rows = await db.like.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { userId_postId: { userId: user.id, postId: cursor } }, skip: 1 } : {}),
      include: { post: { include: postInclude(viewerId) } },
    });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: pageRows.map((r) => serializePost(r.post)),
      nextCursor: hasMore ? pageRows[pageRows.length - 1].postId : null,
    };
  }

  let where: any = { authorId: user.id };
  if (tab === 'posts') where = { authorId: user.id, parentId: null };
  if (tab === 'replies') where = { authorId: user.id, parentId: { not: null } };
  if (tab === 'media') where = { authorId: user.id, media: { some: {} } };

  const items = await db.post.findMany({
    where,
    include: postInclude(viewerId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const { page, nextCursor } = paginate(items, limit);
  let result = page.map(serializePost);

  // Surface the pinned post at the top of the first page of the "posts" tab.
  if (tab === 'posts' && !cursor && user.pinnedPostId) {
    const pinned = await db.post.findUnique({
      where: { id: user.pinnedPostId },
      include: postInclude(viewerId),
    });
    if (pinned) {
      result = [{ ...serializePost(pinned), pinned: true }, ...result.filter((p) => p.id !== pinned.id)];
    }
  }

  return { items: result, nextCursor };
}
