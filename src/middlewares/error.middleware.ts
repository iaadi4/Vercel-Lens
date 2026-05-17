import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.util";

export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  logger.error(err);
  res.status(500).json({ message: "Internal Server Error" });
}
