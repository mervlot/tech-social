import { useInfiniteQuery } from '@tanstack/react-query';
import { MessageSquareDashed, AlertTriangle } from 'lucide-react';
import { useIntersection } from '../hooks/useIntersection';
import { VirtualizedPostList } from './VirtualizedPostList';
import { useT } from '../lib/i18n';
import { PostSkeletonList } from './PostSkeleton';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';
import type { Post } from '../types';
import type { LucideIcon } from 'lucide-react';

interface PageResult {
  items: Post[];
  next: string | number | null;
}

interface Props {
  queryKey: unknown[];
  fetchPage: (pageParam: string | number | undefined) => Promise<PageResult>;
  initialPageParam?: string | number;
  emptyText?: string;
  emptyIcon?: LucideIcon;
  subscribeRealtime?: boolean;
}

// Generic cursor/page-based infinite feed shared by Home, Explore, Profile,
// Bookmarks, Hashtag and Search.
export function Feed({ queryKey, fetchPage, initialPageParam, emptyText = 'Nothing here yet.', emptyIcon, subscribeRealtime }: Props) {
  const t = useT();
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam as string | number | undefined),
    initialPageParam,
    getNextPageParam: (last) => last.next ?? undefined,
  });

  const sentinelRef = useIntersection(
    () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
    query.hasNextPage && !query.isFetchingNextPage,
  );

  if (query.isLoading) return <PostSkeletonList />;
  if (query.isError)
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load posts"
        subtitle="Something went wrong. Check your connection and try again."
      >
        <button onClick={() => query.refetch()} className="btn-outline">
          Retry
        </button>
      </EmptyState>
    );

  const posts = query.data?.pages.flatMap((p) => p.items) ?? [];
  // De-duplicate (reposts of the same original can appear across pages).
  const seen = new Set<string>();
  const unique = posts.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  if (unique.length === 0)
    return <EmptyState icon={emptyIcon ?? MessageSquareDashed} title={emptyText} />;

  return (
    <div>
      <VirtualizedPostList posts={unique} subscribeRealtime={subscribeRealtime} />
      <div ref={sentinelRef} />
      {query.isFetchingNextPage && <Spinner />}
      {!query.hasNextPage && <p className="py-8 text-center text-sm text-gray-500">{t('caughtUp')}</p>}
    </div>
  );
}
