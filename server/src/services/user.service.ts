import { db } from '../config/db';
import { ApiError } from '../utils/apiError';
import { authorSelect } from './serializers';
import { createNotification, removeNotification } from './notification.service';

// Public profile shape including follow counts and the viewer's relationship.
export async function getProfile(username: string, viewerId?: string) {
  const user = await db.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      link: true,
      location: true,
      gameStatus: true,
      avatarUrl: true,
      bannerUrl: true,
      verified: true,
      lastSeenAt: true,
      createdAt: true,
      pinnedPostId: true,
      _count: { select: { followers: true, following: true, posts: true } },
    },
  });
  if (!user) throw ApiError.notFound('User not found');

  let relationship = { isFollowing: false, isFollowedBy: false, isBlocked: false, isMuted: false, isSelf: false };
  if (viewerId) {
    const [following, followedBy, blocked, muted] = await Promise.all([
      db.follow.findUnique({ where: { followerId_followingId: { followerId: viewerId, followingId: user.id } } }),
      db.follow.findUnique({ where: { followerId_followingId: { followerId: user.id, followingId: viewerId } } }),
      db.block.findUnique({ where: { blockerId_blockedId: { blockerId: viewerId, blockedId: user.id } } }),
      db.mute.findUnique({ where: { muterId_mutedId: { muterId: viewerId, mutedId: user.id } } }),
    ]);
    relationship = {
      isFollowing: !!following,
      isFollowedBy: !!followedBy,
      isBlocked: !!blocked,
      isMuted: !!muted,
      isSelf: viewerId === user.id,
    };
  }

  return {
    ...user,
    counts: { followers: user._count.followers, following: user._count.following, posts: user._count.posts },
    relationship,
  };
}

interface UpdateProfileArgs {
  displayName?: string;
  bio?: string | null;
  link?: string | null;
  location?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
}

export async function updateProfile(userId: string, data: UpdateProfileArgs) {
  const user = await db.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      username: true,
      displayName: true,
      bio: true,
      link: true,
      location: true,
      gameStatus: true,
      avatarUrl: true,
      bannerUrl: true,
      verified: true,
      createdAt: true,
    },
  });
  return user;
}

// ─────────────────────── Follow graph ───────────────────────

export async function followUser(followerId: string, username: string) {
  const target = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!target) throw ApiError.notFound('User not found');
  if (target.id === followerId) throw ApiError.badRequest('You cannot follow yourself');

  const blocked = await db.block.findFirst({
    where: {
      OR: [
        { blockerId: target.id, blockedId: followerId },
        { blockerId: followerId, blockedId: target.id },
      ],
    },
  });
  if (blocked) throw ApiError.forbidden('Cannot follow a blocked user');

  await db.follow.upsert({
    where: { followerId_followingId: { followerId, followingId: target.id } },
    create: { followerId, followingId: target.id },
    update: {},
  });
  await createNotification({ type: 'FOLLOW', recipientId: target.id, actorId: followerId });
  return getFollowCounts(target.id);
}

export async function unfollowUser(followerId: string, username: string) {
  const target = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!target) throw ApiError.notFound('User not found');
  await db.follow.deleteMany({ where: { followerId, followingId: target.id } });
  await removeNotification({ type: 'FOLLOW', recipientId: target.id, actorId: followerId });
  return getFollowCounts(target.id);
}

async function getFollowCounts(userId: string) {
  const counts = await db.user.findUnique({
    where: { id: userId },
    select: { _count: { select: { followers: true, following: true } } },
  });
  return { followers: counts?._count.followers ?? 0, following: counts?._count.following ?? 0 };
}

async function listRelationUsers(
  rows: { otherId: string }[],
  viewerId?: string,
) {
  const ids = rows.map((r) => r.otherId);
  if (!ids.length) return [];
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { ...authorSelect },
  });
  // Preserve the original (paginated) ordering.
  const byId = new Map(users.map((u) => [u.id, u]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as typeof users;

  if (!viewerId) return ordered.map((u) => ({ ...u, isFollowing: false }));
  const following = await db.follow.findMany({
    where: { followerId: viewerId, followingId: { in: ids } },
    select: { followingId: true },
  });
  const followingSet = new Set(following.map((f) => f.followingId));
  return ordered.map((u) => ({ ...u, isFollowing: followingSet.has(u.id) }));
}

export async function listFollowers(username: string, viewerId?: string, cursor?: string, limit = 20) {
  const user = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw ApiError.notFound('User not found');
  const rows = await db.follow.findMany({
    where: { followingId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { followerId_followingId: { followerId: cursor, followingId: user.id } }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await listRelationUsers(page.map((r) => ({ otherId: r.followerId })), viewerId);
  return { items, nextCursor: hasMore ? page[page.length - 1].followerId : null };
}

export async function listFollowing(username: string, viewerId?: string, cursor?: string, limit = 20) {
  const user = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!user) throw ApiError.notFound('User not found');
  const rows = await db.follow.findMany({
    where: { followerId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { followerId_followingId: { followerId: user.id, followingId: cursor } }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = await listRelationUsers(page.map((r) => ({ otherId: r.followingId })), viewerId);
  return { items, nextCursor: hasMore ? page[page.length - 1].followingId : null };
}

// ─────────────────────── Block / mute ───────────────────────

export async function blockUser(blockerId: string, username: string) {
  const target = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!target) throw ApiError.notFound('User not found');
  if (target.id === blockerId) throw ApiError.badRequest('You cannot block yourself');

  await db.$transaction([
    db.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId: target.id } },
      create: { blockerId, blockedId: target.id },
      update: {},
    }),
    // Blocking removes any mutual follow relationship.
    db.follow.deleteMany({
      where: {
        OR: [
          { followerId: blockerId, followingId: target.id },
          { followerId: target.id, followingId: blockerId },
        ],
      },
    }),
  ]);
}

export async function unblockUser(blockerId: string, username: string) {
  const target = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!target) throw ApiError.notFound('User not found');
  await db.block.deleteMany({ where: { blockerId, blockedId: target.id } });
}

export async function muteUser(muterId: string, username: string) {
  const target = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!target) throw ApiError.notFound('User not found');
  if (target.id === muterId) throw ApiError.badRequest('You cannot mute yourself');
  await db.mute.upsert({
    where: { muterId_mutedId: { muterId, mutedId: target.id } },
    create: { muterId, mutedId: target.id },
    update: {},
  });
}

export async function unmuteUser(muterId: string, username: string) {
  const target = await db.user.findUnique({ where: { username }, select: { id: true } });
  if (!target) throw ApiError.notFound('User not found');
  await db.mute.deleteMany({ where: { muterId, mutedId: target.id } });
}

// "Who to follow": users the viewer doesn't already follow, isn't, and hasn't
// blocked/muted — ordered by popularity (follower count).
export async function getSuggestions(viewerId: string, limit = 3) {
  const [following, hidden] = await Promise.all([
    db.follow.findMany({ where: { followerId: viewerId }, select: { followingId: true } }),
    getHiddenUserIds(viewerId),
  ]);
  const exclude = [viewerId, ...following.map((f) => f.followingId), ...hidden];

  const users = await db.user.findMany({
    where: { id: { notIn: exclude } },
    select: { ...authorSelect },
    orderBy: { followers: { _count: 'desc' } },
    take: limit,
  });
  return users.map((u) => ({ ...u, isFollowing: false }));
}

// Returns the set of user ids the viewer should not see content from
// (people they block, people who block them, and muted users).
export async function getHiddenUserIds(viewerId: string): Promise<string[]> {
  const [blocking, blockedBy, muting] = await Promise.all([
    db.block.findMany({ where: { blockerId: viewerId }, select: { blockedId: true } }),
    db.block.findMany({ where: { blockedId: viewerId }, select: { blockerId: true } }),
    db.mute.findMany({ where: { muterId: viewerId }, select: { mutedId: true } }),
  ]);
  return [
    ...new Set([
      ...blocking.map((b) => b.blockedId),
      ...blockedBy.map((b) => b.blockerId),
      ...muting.map((m) => m.mutedId),
    ]),
  ];
}
