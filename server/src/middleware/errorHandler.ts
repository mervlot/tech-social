import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/apiError';

// Central error translator. Anything thrown in the request lifecycle ends up
// here and is mapped to a clean JSON shape: { error: { message, details? } }.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { message: err.message, details: err.details } });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof Error) {
    const databaseError = err as Error & { code?: string; meta?: { target?: string[] } };
    if (databaseError.code === 'P2002') {
      const target = databaseError.meta?.target?.join(', ');
      return res
        .status(409)
        .json({ error: { message: `Already exists${target ? `: ${target}` : ''}` } });
    }
    if (databaseError.code === 'P2025') {
      return res.status(404).json({ error: { message: 'Resource not found' } });
    }
  }

  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: { message: 'Internal server error' } });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { message: 'Route not found' } });
}
