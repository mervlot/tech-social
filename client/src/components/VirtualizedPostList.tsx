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
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const viewportTop = Math.max(0, -rect.top);
    const viewportBottom = viewportTop + window.innerHeight;
    const first = Math.max(0, offsets.offsets.findIndex((value, index) => {
      const height = heightsRef.current.get(posts[index]?.id) ?? ESTIMATED_HEIGHT;
      return value + height >= viewportTop;
    }) - overscan);
    let last = first;
    while (last < posts.length && offsets.offsets[last] < viewportBottom) last += 1;
    setRange((current) => current.start === first && current.end === Math.min(posts.length, last + overscan) ? current : {
      start: first,
      end: Math.min(posts.length, last + overscan),
    });
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
