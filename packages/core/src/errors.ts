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

export class TooManyRequestsError extends AthenaError {
  constructor(message = "Too many requests") {
    super(message, "too_many_requests", 429);
  }
}

export class ServiceUnavailableError extends AthenaError {
  constructor(message = "Service unavailable") {
    super(message, "service_unavailable", 503);
  }
}
