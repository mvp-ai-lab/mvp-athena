export class AthenaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "AthenaError";
  }
}

export class NotFoundError extends AthenaError {
  constructor(message = "Resource not found") {
    super(message, "not_found", 404);
  }
}

export class ForbiddenError extends AthenaError {
  constructor(message = "Forbidden") {
    super(message, "forbidden", 403);
  }
}

export class UnauthorizedError extends AthenaError {
  constructor(message = "Unauthorized") {
    super(message, "unauthorized", 401);
  }
}

export class ConflictError extends AthenaError {
  constructor(message = "The resource changed since it was last read") {
    super(message, "conflict", 409);
  }
}

export class ValidationError extends AthenaError {
  constructor(message = "Invalid input") {
    super(message, "validation_error", 400);
  }
}
