import { NextFunction, Request, Response } from 'express';
import { ActorContext, Role } from '../types/domain';

declare global {
  namespace Express {
    interface Request {
      actor?: ActorContext;
    }
  }
}

const validRoles = new Set<Role>(['admin', 'physician', 'patient']);

export const actorMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  const roleHeader = `${req.header('x-role') || 'admin'}`.toLowerCase();
  const role: Role = validRoles.has(roleHeader as Role) ? (roleHeader as Role) : 'admin';
  const actorId = req.header('x-actor-id') || req.query.actor_id?.toString() || null;

  req.actor = {
    role,
    actorId
  };

  next();
};

export const requireRole = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = req.actor;
    if (!actor || !roles.includes(actor.role)) {
      res.status(403).json({ error: 'Access denied for this role.' });
      return;
    }
    next();
  };
};
