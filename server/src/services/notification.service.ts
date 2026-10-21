import { db } from '../config/db';
import { NotificationType } from '../types/enums';
import { emitToUser } from '../sockets/io';
import { authorSelect } from './serializers';

const notificationInclude = {
  actor: { select: authorSelect },
  post: {
    select: {
      id: true,
      content: true,
      author: { select: authorSelect },
    },
  },
} satisfies Record<string, unknown>;

interface CreateArgs {
  type: NotificationType;
  recipientId: string;
  actorId: string;
  postId?: string;
}

// Creates a notification and pushes it in realtime to the recipient.
// Self-notifications (acting on your own content) are skipped.
export async function createNotification({ type, recipientId, actorId, postId }: CreateArgs) {
  if (recipientId === actorId) return null;

  const notification = await db.notification.create({
    data: { type, recipientId, actorId, postId },
    include: notificationInclude,
  });

  emitToUser(recipientId, 'notification:new', notification);
  const unread = await db.notification.count({ where: { recipientId, read: false } });
  emitToUser(recipientId, 'notification:count', { unread });

  return notification;
}

// Removes a notification that no longer applies (e.g. after an unlike/unfollow).
export async function removeNotification({ type, recipientId, actorId, postId }: CreateArgs) {
  if (recipientId === actorId) return;
  await db.notification.deleteMany({
    where: { type, recipientId, actorId, postId: postId ?? null },
  });
  const unread = await db.notification.count({ where: { recipientId, read: false } });
  emitToUser(recipientId, 'notification:count', { unread });
}

export async function listNotifications(userId: string, cursor?: string, limit = 20) {
  const items = await db.notification.findMany({
    where: { recipientId: userId },
    include: notificationInclude,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

export async function unreadCount(userId: string) {
  return db.notification.count({ where: { recipientId: userId, read: false } });
}

export async function markAllRead(userId: string) {
  await db.notification.updateMany({
    where: { recipientId: userId, read: false },
    data: { read: true },
  });
  emitToUser(userId, 'notification:count', { unread: 0 });
}
