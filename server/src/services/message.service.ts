import { db } from '../config/db';
import { ApiError } from '../utils/apiError';
import { authorSelect } from './serializers';
import { emitToUser } from '../sockets/io';

// A 1:1 conversation is keyed by an ordered pair so (A,B) and (B,A) map to one row.
function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function ensureNotBlocked(a: string, b: string) {
  const blocked = await db.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
  });
  if (blocked) throw ApiError.forbidden('Messaging is unavailable with this user');
}

// Collapse raw reaction rows into [{ emoji, userIds }] for the client (which
// derives count and "mine" from userIds — both DM participants are known).
function groupReactions(reactions: Array<{ userId: string; emoji: string }>) {
  const map = new Map<string, string[]>();
  for (const r of reactions) {
    const ids = map.get(r.emoji) ?? [];
    ids.push(r.userId);
    map.set(r.emoji, ids);
  }
  return [...map.entries()].map(([emoji, userIds]) => ({ emoji, userIds }));
}

const messageInclude = {
  reactions: { select: { userId: true, emoji: true } },
  replyTo: {
    select: {
      id: true,
      senderId: true,
      content: true,
      imageUrl: true,
      audioUrl: true,
      videoNoteUrl: true,
      deletedAt: true,
    },
  },
} as const;

// Compact snippet of the message being replied to, rendered inside the bubble.
function serializeReplyTo(r: any) {
  if (!r) return null;
  const deleted = Boolean(r.deletedAt);
  return {
    id: r.id,
    senderId: r.senderId,
    content: deleted ? null : r.content ?? null,
    kind: deleted
      ? 'deleted'
      : r.audioUrl
        ? 'voice'
        : r.videoNoteUrl
          ? 'video'
          : r.imageUrl
            ? 'image'
            : 'text',
  };
}

// Public message shape. Soft-deleted messages drop their content/media.
function serializeMessage(m: any) {
  const deleted = Boolean(m.deletedAt);
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    content: deleted ? null : m.content ?? null,
    imageUrl: deleted ? null : m.imageUrl ?? null,
    audioUrl: deleted ? null : m.audioUrl ?? null,
    videoNoteUrl: deleted ? null : m.videoNoteUrl ?? null,
    mediaDurationMs: m.mediaDurationMs ?? null,
    editedAt: m.editedAt ?? null,
    deletedAt: m.deletedAt ?? null,
    replyTo: deleted ? null : serializeReplyTo(m.replyTo),
    reactions: groupReactions(m.reactions ?? []),
    readAt: m.readAt ?? null,
    createdAt: m.createdAt,
  };
}

// Re-fetch a message with reactions and push it to both participants.
async function emitMessageUpdate(conversationId: string, messageId: string) {
  const [fresh, conv] = await Promise.all([
    db.message.findUnique({ where: { id: messageId }, include: messageInclude }),
    db.conversation.findUnique({ where: { id: conversationId } }),
  ]);
  if (!fresh || !conv) return null;
  const message = serializeMessage(fresh);
  emitToUser(conv.userAId, 'dm:update', { conversationId, message });
  emitToUser(conv.userBId, 'dm:update', { conversationId, message });
  return message;
}

export async function getOrCreateConversation(userId: string, otherUsername: string) {
  const other = await db.user.findUnique({ where: { username: otherUsername }, select: { id: true } });
  if (!other) throw ApiError.notFound('User not found');
  if (other.id === userId) throw ApiError.badRequest('You cannot message yourself');
  await ensureNotBlocked(userId, other.id);

  const [userAId, userBId] = orderPair(userId, other.id);
  const conversation = await db.conversation.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    create: { userAId, userBId },
    update: {},
    include: {
      userA: { select: authorSelect },
      userB: { select: authorSelect },
    },
  });
  return shapeConversation(conversation, userId);
}

function shapeConversation(c: any, viewerId: string) {
  const other = c.userAId === viewerId ? c.userB : c.userA;
  return {
    id: c.id,
    other,
    lastMessage: c.messages?.[0]
      ? {
          id: c.messages[0].id,
          content: c.messages[0].content,
          imageUrl: c.messages[0].imageUrl ?? null,
          audioUrl: c.messages[0].audioUrl ?? null,
          videoNoteUrl: c.messages[0].videoNoteUrl ?? null,
          senderId: c.messages[0].senderId,
          createdAt: c.messages[0].createdAt,
          readAt: c.messages[0].readAt,
        }
      : null,
    unread: c._unread ?? 0,
    updatedAt: c.updatedAt,
  };
}

export async function listConversations(userId: string) {
  const conversations = await db.conversation.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { updatedAt: 'desc' },
    include: {
      userA: { select: authorSelect },
      userB: { select: authorSelect },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  // Compute unread counts (messages sent by the other user, not yet read).
  const withUnread = await Promise.all(
    conversations.map(async (c) => {
      const unread = await db.message.count({
        where: { conversationId: c.id, senderId: { not: userId }, readAt: null },
      });
      return shapeConversation({ ...c, _unread: unread }, userId);
    }),
  );
  return withUnread;
}

// Fetches a single conversation's metadata for a participant. Lets the client
// open a chat by id even when its conversation list cache is empty or stale.
export async function getConversation(conversationId: string, userId: string) {
  const c = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      userA: { select: authorSelect },
      userB: { select: authorSelect },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!c || (c.userAId !== userId && c.userBId !== userId)) {
    throw ApiError.notFound('Conversation not found');
  }
  const unread = await db.message.count({
    where: { conversationId: c.id, senderId: { not: userId }, readAt: null },
  });
  return shapeConversation({ ...c, _unread: unread }, userId);
}

async function assertParticipant(conversationId: string, userId: string) {
  const c = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!c) throw ApiError.notFound('Conversation not found');
  if (c.userAId !== userId && c.userBId !== userId) throw ApiError.forbidden('Not a participant');
  return c;
}

export async function getMessages(conversationId: string, userId: string, cursor?: string, limit = 30) {
  await assertParticipant(conversationId, userId);
  const items = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: messageInclude,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  // Returned newest-first; the client reverses for display.
  return { items: page.map(serializeMessage), nextCursor: hasMore ? page[page.length - 1].id : null };
}

interface MessageAttachments {
  imageUrl?: string;
  audioUrl?: string;
  videoNoteUrl?: string;
  mediaDurationMs?: number;
  replyToId?: string;
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
  attachments: MessageAttachments = {},
) {
  const conv = await assertParticipant(conversationId, senderId);
  const text = content.trim();
  const { imageUrl, audioUrl, videoNoteUrl, mediaDurationMs, replyToId } = attachments;
  const hasMedia = Boolean(imageUrl || audioUrl || videoNoteUrl);
  if (!text && !hasMedia) throw ApiError.badRequest('Message cannot be empty');
  const otherId = conv.userAId === senderId ? conv.userBId : conv.userAId;
  await ensureNotBlocked(senderId, otherId);

  // A reply must target a message inside the same conversation.
  if (replyToId) {
    const target = await db.message.findFirst({
      where: { id: replyToId, conversationId },
      select: { id: true },
    });
    if (!target) throw ApiError.badRequest('The message you are replying to was not found');
  }

  const [message] = await db.$transaction([
    db.message.create({
      data: {
        conversationId,
        senderId,
        content: text || null,
        imageUrl,
        audioUrl,
        videoNoteUrl,
        mediaDurationMs: mediaDurationMs ?? null,
        replyToId: replyToId ?? null,
      },
      include: messageInclude,
    }),
    db.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
  ]);

  const serialized = serializeMessage(message);
  // Realtime delivery to both participants.
  emitToUser(otherId, 'dm:new', { conversationId, message: serialized });
  emitToUser(senderId, 'dm:new', { conversationId, message: serialized });
  return serialized;
}

// Toggle an emoji reaction on a message; notifies both participants.
export async function reactToMessage(
  conversationId: string,
  messageId: string,
  userId: string,
  emoji: string,
) {
  await assertParticipant(conversationId, userId);
  const message = await db.message.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, deletedAt: true },
  });
  if (!message) throw ApiError.notFound('Message not found');
  if (message.deletedAt) throw ApiError.badRequest('Cannot react to a deleted message');

  const existing = await db.messageReaction.findUnique({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
  });
  if (existing) {
    await db.messageReaction.delete({ where: { id: existing.id } });
  } else {
    await db.messageReaction.create({ data: { messageId, userId, emoji } });
  }
  return emitMessageUpdate(conversationId, messageId);
}

// Edit the text of your own message; notifies both participants.
export async function editMessage(
  conversationId: string,
  messageId: string,
  userId: string,
  content: string,
) {
  await assertParticipant(conversationId, userId);
  const message = await db.message.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, senderId: true, deletedAt: true, audioUrl: true, videoNoteUrl: true },
  });
  if (!message) throw ApiError.notFound('Message not found');
  if (message.senderId !== userId) throw ApiError.forbidden('You can only edit your own messages');
  if (message.deletedAt) throw ApiError.badRequest('Cannot edit a deleted message');
  if (message.audioUrl || message.videoNoteUrl) {
    throw ApiError.badRequest('Voice and video messages cannot be edited');
  }
  const text = content.trim();
  if (!text) throw ApiError.badRequest('Message cannot be empty');

  await db.message.update({
    where: { id: messageId },
    data: { content: text, editedAt: new Date() },
  });
  return emitMessageUpdate(conversationId, messageId);
}

// Soft-delete your own message ("message deleted"); notifies both participants.
export async function deleteMessage(conversationId: string, messageId: string, userId: string) {
  await assertParticipant(conversationId, userId);
  const message = await db.message.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, senderId: true },
  });
  if (!message) throw ApiError.notFound('Message not found');
  if (message.senderId !== userId) throw ApiError.forbidden('You can only delete your own messages');

  await db.$transaction([
    db.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: null, imageUrl: null, audioUrl: null, videoNoteUrl: null },
    }),
    db.messageReaction.deleteMany({ where: { messageId } }),
  ]);
  return emitMessageUpdate(conversationId, messageId);
}

// Marks all messages from the *other* participant as read. Returns the other
// user's id so the caller (socket handler) can notify them.
export async function markConversationRead(conversationId: string, userId: string): Promise<string | null> {
  const conv = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conv || (conv.userAId !== userId && conv.userBId !== userId)) return null;
  await db.message.updateMany({
    where: { conversationId, senderId: { not: userId }, readAt: null },
    data: { readAt: new Date() },
  });
  return conv.userAId === userId ? conv.userBId : conv.userAId;
}
