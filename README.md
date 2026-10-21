# Murmur — a full-stack social network (Twitter/X-style)

> *Where the world thinks out loud.*

A working social network built with a RESTful Node.js/Express + SQLite backend and
a React + TypeScript + Tailwind frontend, with Socket.io for realtime notifications
and direct messages. All data is persisted in a real database — there are no mocks.

The project runs out-of-the-box on **SQLite** (zero install) and can switch to
**PostgreSQL** for production by changing one line (see *Database* below).

---

## ✨ Features

**Auth & profiles**
- Register, login, logout, password reset, change password
- JWT access tokens (in memory) + rotating refresh tokens (httpOnly cookie), bcrypt password hashing
- Profiles with avatar, banner, bio, link, location, join date; profile editing
- Follow / unfollow with live follower & following counts

**Posts**
- Compose posts (280-char limit) with images, video and GIFs (up to 4 attachments)
- Polls (2-4 options, 1h-7d) with live-updating animated results, vote
  switching until close, and leader highlighting
- Likes, reposts (retweets), quote-reposts
- Replies with nested threads (ancestors + replies)
- Delete your own posts; pin a post to your profile
- Like / repost / reply counters update in **realtime** via WebSocket

**Timelines**
- Home: "Following" (chronological) and "For you" (ranked) tabs
- Explore with a basic engagement+recency ranking algorithm
- Infinite scroll everywhere (cursor / page pagination)

**Discovery**
- Search users and posts
- Clickable hashtags with dedicated hashtag pages
- Trending hashtags (last 7 days)

**Stories**
- 24-hour photo/video stories with a story ring bar on the Home feed
- Full-screen viewer: segmented progress bars, auto-advance, hold-to-pause,
  tap / arrow-key navigation
- Unseen/seen rings, view receipts with a per-story viewers list (author only),
  delete your own stories
- Reply to a story or send a quick emoji reaction — delivered as a DM with a
  thumbnail of the story
- Story composer: preview the photo/video and add a caption before publishing

**Notifications** (realtime)
- Likes, reposts, quotes, replies, follows, @mentions
- Unread badge pushed over WebSocket

**Direct messages** (realtime)
- 1:1 conversations, typing indicators, read receipts (✓ sent / ✓✓ read)
- Reply to messages (quoted snippet, click to jump back) and edit sent
  messages with an "edited" label
- Forward messages to other conversations
- Share any post into a conversation as a rich card that deep-links back to it
- "Online now" row and live "typing..." previews in the conversation list
- Post drafts autosave locally so a refresh never loses a half-written post

**Design ("Aurora")**
- Electric-violet + cyan palette over an ambient aurora backdrop, Manrope
  typeface (bundled locally, CSP-safe)
- Feed rendered as floating frosted-glass cards; floating rounded dock
  navigation on mobile, gradient pill navigation on desktop
- Living motion design: slowly-drifting aurora background, confetti like
  bursts, light sweeps on buttons, spinning unseen-story rings, spring
  modals, blurred page transitions — all disabled under
  `prefers-reduced-motion`

**Extras**
- Interface translations: English, Русский, Українська, Español — picker in
  Settings, auto-detected from the browser on first visit
- Light / dark theme (persisted) with smooth transitions
- Fully responsive (mobile bottom-nav + desktop three-column layout)
- Bookmarks
- Block & mute users
- Polished animations throughout (post entry, like burst, modal/lightbox)
- In-app toast notifications for actions
- Full-screen media lightbox with keyboard navigation
- Compose character-count ring
- @mention and #hashtag autocomplete while composing (keyboard-navigable)
- "Who to follow" suggestions
- Per-post view counts
- Skeleton loading states

---

## 🧱 Tech stack

| Layer      | Choice                                                        |
| ---------- | ------------------------------------------------------------- |
| Frontend   | React, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand |
| Backend    | Node.js, Express, TypeScript                                  |
| Database   | PostgreSQL via SQLite ORM                                     |
| Auth       | JWT + refresh tokens, bcryptjs                                |
| Realtime   | Socket.io                                                     |
| Media      | Local disk storage via multer (abstracted behind a URL helper)|
| API style  | **REST** (`/api/...`)                                          |

---

## 📋 Prerequisites

- **Node.js** ≥ 18
- For the default setup: **nothing else** — SQLite is file-based.
- For production: **PostgreSQL** ≥ 13 (optional, see *Database*).

---

## 🚀 Getting started

```bash
# from the repository root
cd social-network
```

### 1. Backend

```bash
cd server
npm install
cp .env.example .env        # (Windows cmd: copy .env.example .env)
```

The committed `.env.example` defaults to SQLite, so you usually only need to set
the JWT secrets:

```env
DATABASE_URL="file:./dev.db"
JWT_ACCESS_SECRET=<random string>
JWT_REFRESH_SECRET=<random string>
CLIENT_URL=http://localhost:5173
API_URL=http://localhost:4000
```

Optional Google sign-in:

```env
GOOGLE_CLIENT_ID=<google oauth client id>
GOOGLE_CLIENT_SECRET=<google oauth client secret>
GOOGLE_CALLBACK_URL=http://localhost:4000/api/auth/google/callback
```

In Google Cloud Console, add this authorized redirect URI:
`http://localhost:4000/api/auth/google/callback`.

Create the database schema and start the server:

```bash
npm run sqlite:migrate        # creates dev.db and applies migrations
npm run sqlite:generate       # (usually run automatically by migrate)

# start the API + WebSocket server on http://localhost:4000
npm run dev
```

### 2. Frontend

```bash
cd ../client
npm install
cp .env.example .env          # VITE_API_URL defaults to http://localhost:4000
npm run dev                   # http://localhost:5173
```

Open **http://localhost:5173** and create an account to get started.

> **Password reset in dev:** `POST /api/auth/forgot-password` returns the
> six-digit reset code directly in the JSON. Production sends it by SMTP.

---

## 🗂 Project structure

```
social-network/
├── server/
│   ├── sqlite/
│   │   ├── sqlite-schema-removed         # data model
│   │   └── migrations/           # generated SQL migrations
│   └── src/
│       ├── config/               # env + SQLite client
│       ├── middleware/           # auth, validation, rate-limit, uploads, errors
│       ├── validators/           # zod schemas
│       ├── services/             # business logic (auth, post, feed, user, …)
│       ├── controllers/          # thin HTTP handlers
│       ├── routes/               # REST route definitions
│       ├── sockets/              # Socket.io setup + emit helpers
│       ├── utils/                # jwt, password, errors, text parsing
│       ├── app.ts                # express app (helmet, cors, routes)
│       └── index.ts              # http server + socket bootstrap
└── client/
    └── src/
        ├── components/           # reusable UI (PostCard, Feed, Layout, …)
        ├── pages/                # routed screens
        ├── store/                # zustand stores (auth, theme, realtime)
        ├── hooks/                # custom hooks (infinite scroll)
        ├── lib/                  # api client, socket, formatters
        └── types.ts              # shared TypeScript types
```

---

## 🔌 API overview (REST)

Base URL: `http://localhost:4000/api`

### Auth
| Method | Endpoint                | Description                       |
| ------ | ----------------------- | --------------------------------- |
| POST   | `/auth/register`        | Create account                    |
| POST   | `/auth/login`           | Login (email or username)         |
| POST   | `/auth/refresh`         | Rotate refresh token → new access |
| POST   | `/auth/logout`          | Revoke refresh token              |
| GET    | `/auth/me`              | Current user                      |
| POST   | `/auth/forgot-password` | Request reset code                |
| POST   | `/auth/reset-password`  | Reset with email code             |
| POST   | `/auth/change-password` | Change while logged in            |

### Users
| Method | Endpoint                       | Description                  |
| ------ | ------------------------------ | ---------------------------- |
| GET    | `/users/:username`             | Public profile + relationship|
| PATCH  | `/users/profile`               | Edit own profile (multipart) |
| GET    | `/users/:username/posts?tab=`  | posts/replies/media/likes    |
| GET    | `/users/:username/followers`   | Followers (paginated)        |
| GET    | `/users/:username/following`   | Following (paginated)        |
| POST   | `/users/:username/follow`      | Follow / unfollow (DELETE)   |
| POST   | `/users/:username/block`       | Block / unblock (DELETE)     |
| POST   | `/users/:username/mute`        | Mute / unmute (DELETE)       |

### Posts
| Method | Endpoint                | Description                         |
| ------ | ----------------------- | ----------------------------------- |
| POST   | `/posts`                | Create (multipart, up to 4 media)   |
| GET    | `/posts/:id`            | Single post                         |
| GET    | `/posts/:id/thread`     | Post + ancestor chain               |
| GET    | `/posts/:id/replies`    | Replies (paginated)                 |
| DELETE | `/posts/:id`            | Delete own post                     |
| POST   | `/posts/:id/like`       | Like / unlike (DELETE)              |
| POST   | `/posts/:id/repost`     | Repost / undo (DELETE)              |
| POST   | `/posts/:id/bookmark`   | Bookmark / remove (DELETE)          |
| POST   | `/posts/:id/pin`        | Pin / unpin (DELETE)                |
| GET    | `/posts/bookmarks`      | Your bookmarks                      |

### Feed / discovery
| Method | Endpoint              | Description                |
| ------ | --------------------- | -------------------------- |
| GET    | `/feed/home`          | Following timeline         |
| GET    | `/feed/explore`       | Ranked "for you" feed      |
| GET    | `/search?q=&type=`    | type = top/users/posts     |
| GET    | `/hashtags/:tag`      | Posts for a hashtag        |
| GET    | `/trends`             | Trending hashtags          |

### Notifications & messages
| Method | Endpoint                          | Description           |
| ------ | --------------------------------- | --------------------- |
| GET    | `/notifications`                  | List (paginated)      |
| GET    | `/notifications/unread-count`     | Unread count          |
| POST   | `/notifications/read`             | Mark all read         |
| GET    | `/conversations`                  | Conversation list     |
| POST   | `/conversations`                  | Start/get with a user |
| GET    | `/conversations/:id/messages`     | Messages (paginated)  |
| POST   | `/conversations/:id/messages`     | Send a message        |
| POST   | `/conversations/:id/read`         | Mark conversation read|

### WebSocket events (Socket.io)
Authenticate by passing the access token in the handshake `auth.token`.

- Server → client: `notification:new`, `notification:count`, `dm:new`, `dm:typing`, `dm:read`, `post:counts`
- Client → server: `post:subscribe`/`post:unsubscribe` (live counts), `dm:typing`, `dm:read`

---

## 🔐 Security

- **Passwords** hashed with bcrypt (12 rounds).
- **JWT access tokens** are short-lived and kept in memory (not localStorage);
  **refresh tokens** are random, stored only as SHA-256 hashes, rotated on use,
  and delivered via an httpOnly cookie scoped to `/api/auth`.
- **SQL injection**: all DB access goes through SQLite's parameterised queries.
- **XSS**: post content is rendered as React text nodes / elements — never via
  `dangerouslySetInnerHTML`.
- **Validation**: every endpoint validates input with zod (mirrored on the client).
- **Rate limiting**: global limiter + stricter limiters on auth and write endpoints.
- **Headers/CORS**: `helmet` security headers; CORS restricted to `CLIENT_URL`.

---

## 🛠 Useful commands

```bash
# server
npm run dev              # dev server with reload
npm run build            # compile TypeScript to dist/
npm start                # run compiled server
npm run sqlite:studio    # browse the DB in SQLite Studio
npm run sqlite:migrate   # create & apply a migration

# client
npm run dev              # Vite dev server
npm run build            # production build
npm run preview          # preview the production build
```

---

## 🗄 Database — SQLite ↔ PostgreSQL

The app ships configured for **SQLite** so it runs with zero setup. To use
**PostgreSQL** (the production target):

1. In `server/sqlite/sqlite-schema-removed`, set `provider = "postgresql"`.
2. In `server/.env`, point `DATABASE_URL` at your Postgres instance.
3. Run `npm run sqlite:migrate` again.

The data model is written to work on both engines (enums are stored as strings,
and no engine-specific column types are used).

---

## Permanent photo storage

Local development needs no extra setup: uploads are saved under
`server/uploads`.

Render's filesystem is temporary, so production uploads should use Cloudinary:

1. Create a Cloudinary account and open the API Keys page.
2. In the Render service environment, set `CLOUDINARY_CLOUD_NAME`,
   `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
3. Redeploy the backend.

`CLOUDINARY_FOLDER=murmur` is optional. After the three credentials are set,
new post media, avatars, banners, and chat images are uploaded to Cloudinary
automatically. Existing local files are left unchanged.

---

## 📝 Notes & possible extensions

- Media is stored on local disk under `server/uploads` during development.
  For production, set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and
  `CLOUDINARY_API_SECRET`; new post media, avatars, banners, and chat images
  will then be stored permanently in Cloudinary.
- Email delivery for password resets is intentionally stubbed (token returned in
  dev). Wire up a provider (e.g. SES/Resend) in `auth.service.ts`.
- The ranking algorithm in `feed.service.ts` is deliberately simple
  (engagement with time decay) and is a good place to iterate.
