import { db } from '../config/db';
import { ApiError } from '../utils/apiError';
import { authorSelect } from './serializers';
import { emitToUser } from '../sockets/io';

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

function serializeStory(s: any, viewerId: string) {
  return {
    id: s.id,
    mediaUrl: s.mediaUrl,
    mediaType: s.mediaType,
    caption: s.caption ?? null,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    viewed: Array.isArray(s.views) ? s.views.some((v: any) => v.userId === viewerId) : false,
    viewCount: s._count?.views ?? 0,
  };
}

export async function createStory(
  authorId: string,
  mediaUrl: string,
  mediaType: 'IMAGE' | 'VIDEO',
  caption?: string,
) {
  const story = await db.story.create({
    data: {
      authorId,
      mediaUrl,
      mediaType,
      caption: caption?.trim() || null,
      expiresAt: new Date(Date.now() + STORY_TTL_MS),
    },
    include: { author: { select: authorSelect } },
  });

  // Nudge followers (and the author's other tabs) to refresh their story bars.
  const followers = await db.follow.findMany({
    where: { followingId: authorId },
    select: { followerId: true },
  });
  for (const f of followers) emitToUser(f.followerId, 'story:new', { authorId });
  emitToUser(authorId, 'story:new', { authorId });

  return serializeStory({ ...story, views: [], _count: { views: 0 } }, authorId);
}

// Active (non-expired) stories from the viewer and everyone they follow,
// grouped per author. The viewer's own group always comes first; the rest are
// ordered unseen-first, then by most recent story.
export async function getStoriesFeed(userId: string) {
  const following = await db.follow.findMany({
    where: { followerId: userId },
    select: { followingId: true },
  });
  const authorIds = [userId, ...following.map((f) => f.followingId)];

  const stories = await db.story.findMany({
    where: { authorId: { in: authorIds }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    include: {
      author: { select: authorSelect },
      views: { where: { userId }, select: { userId: true } },
      _count: { select: { views: true } },
    },
  });

  const groups = new Map<string, { author: any; stories: any[] }>();
  for (const s of stories) {
    const group = groups.get(s.authorId) ?? { author: s.author, stories: [] };
    group.stories.push(serializeStory(s, userId));
    groups.set(s.authorId, group);
  }

  const shaped = [...groups.values()].map((g) => ({
    author: g.author,
    stories: g.stories,
    allViewed: g.stories.every((s) => s.viewed),
    latestAt: g.stories[g.stories.length - 1].createdAt,
  }));

  shaped.sort((a, b) => {
    if (a.author.id === userId) return -1;
    if (b.author.id === userId) return 1;
    if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
    return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
  });

  return shaped.map(({ latestAt: _latestAt, ...g }) => g);
}

async function getVisibleStory(storyId: string, userId: string) {
  const story = await db.story.findUnique({ where: { id: storyId } });
  if (!story || story.expiresAt <= new Date()) throw ApiError.notFound('Story not found');
  if (story.authorId !== userId) {
    const blocked = await db.block.findFirst({
      where: {
        OR: [
          { blockerId: story.authorId, blockedId: userId },
          { blockerId: userId, blockedId: story.authorId },
        ],
      },
    });
    if (blocked) throw ApiError.notFound('Story not found');
  }
  return story;
}

// Records a view receipt (idempotent). Authors don't count as viewers of
// their own stories.
export async function markStoryViewed(storyId: string, userId: string) {
  const story = await getVisibleStory(storyId, userId);
  if (story.authorId === userId) return;
  const existing = await db.storyView.findUnique({
    where: { storyId_userId: { storyId, userId } },
  });
  if (existing) return;
  // A concurrent duplicate insert can still race past the check; swallow it
  // so repeat views never error and never double-notify.
  await db.storyView.create({ data: { storyId, userId } }).catch(() => null);
  // Let the author's open viewer update its live view counter.
  emitToUser(story.authorId, 'story:viewed', { storyId });
}

// Who has seen a story — available to its author only.
export async function getStoryViewers(storyId: string, userId: string) {
  const story = await db.story.findUnique({ where: { id: storyId } });
  if (!story) throw ApiError.notFound('Story not found');
  if (story.authorId !== userId) throw ApiError.forbidden('Only the author can see story viewers');
  const views = await db.storyView.findMany({
    where: { storyId },
    orderBy: { viewedAt: 'desc' },
    include: { user: { select: authorSelect } },
  });
  return views.map((v) => ({ ...v.user, viewedAt: v.viewedAt }));
}

export async function deleteStory(storyId: string, userId: string) {
  const story = await db.story.findUnique({ where: { id: storyId } });
  if (!story) throw ApiError.notFound('Story not found');
  if (story.authorId !== userId) throw ApiError.forbidden('You can only delete your own stories');
  await db.story.delete({ where: { id: storyId } });
}
