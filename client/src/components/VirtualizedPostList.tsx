import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PostCard } from './PostCard';
import type { Post } from '../types';

interface Props {
  posts: Post[];
  subscribeRealtime?: boolean;
  overscan?: number;
}

const ESTIMATED_HEIGHT = 220;

export function VirtualizedPostList({ posts, subscribeRealtime, overscan = 5 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const heightsRef = useRef(new Map<string, number>());
  const offsetsRef = useRef<number[]>([]);
  const [range, setRange] = useState({ start: 0, end: Math.min(posts.length, 12) });
  const [measurementVersion, forceMeasure] = useState(0);
  const observersRef = useRef(new Map<string, ResizeObserver>());

  const offsets = useMemo(() => {
    const next: number[] = [];
    let offset = 0;
    for (const post of posts) {
      next.push(offset);
      offset += heightsRef.current.get(post.id) ?? ESTIMATED_HEIGHT;
    }
    offsetsRef.current = next;
    return { offsets: next, total: offset };
  }, [posts, measurementVersion]);

  const updateRange = useCallback(() => {
    const host = hostRef.current;
    if (!host || posts.length === 0) return;

    const rect = host.getBoundingClientRect();
    const viewportTop = Math.max(0, -rect.top);
    const viewportBottom = viewportTop + window.innerHeight;

    // Binary search keeps range updates cheap even for feeds with thousands of posts.
    let low = 0;
    let high = posts.length - 1;
    let firstVisible = posts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const height = heightsRef.current.get(posts[middle].id) ?? ESTIMATED_HEIGHT;
      if (offsets.offsets[middle] + height >= viewportTop) {
        firstVisible = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    const first = Math.max(0, firstVisible - overscan);
    let last = firstVisible;
    while (last < posts.length && offsets.offsets[last] < viewportBottom) last += 1;
    const nextEnd = Math.min(posts.length, last + overscan);

    setRange((current) =>
      current.start === first && current.end === nextEnd ? current : { start: first, end: nextEnd },
    );
  }, [offsets.offsets, overscan, posts]);

  useLayoutEffect(() => {
    updateRange();
  }, [updateRange]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateRange);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [updateRange]);

  const measure = useCallback((node: HTMLDivElement | null, id: string) => {
    observersRef.current.get(id)?.disconnect();
    if (!node) {
      observersRef.current.delete(id);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.contentRect.height);
      if (height > 0 && heightsRef.current.get(id) !== height) {
        heightsRef.current.set(id, height);
        forceMeasure((value) => value + 1);
      }
    });
    observersRef.current.set(id, observer);
    observer.observe(node);
  }, []);

  useEffect(() => () => {
    observersRef.current.forEach((observer) => observer.disconnect());
    observersRef.current.clear();
  }, []);

  return (
    <div ref={hostRef} className="relative contain-content" style={{ height: offsets.total }}>
      {posts.slice(range.start, range.end).map((post, visibleIndex) => {
        const index = range.start + visibleIndex;
        return (
          <div
            key={post.id}
            ref={(node) => measure(node, post.id)}
            className="absolute left-0 right-0"
            style={{ transform: `translateY(${offsets.offsets[index] ?? 0}px)` }}
          >
            <PostCard post={post} index={index} subscribeRealtime={subscribeRealtime} />
          </div>
        );
      })}
    </div>
  );
}
