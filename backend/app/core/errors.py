"""Typed errors for failures this application raises on purpose.

Internal detail (operation, entity, identifier, layer) belongs in the message
that reaches the logs. The transport layer maps these types to a user-facing
message that reveals none of it.
"""

from __future__ import annotations


class ApplicationError(Exception):
    """Base class for every error this application raises deliberately."""

    code = "application_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class RecordNotFoundError(ApplicationError):
    """A row the caller needed does not exist.

    Raised by the persistence layer. It is not a validation problem and must
    never be reported to the caller as a successful no-op.
    """

    code = "record_not_found"

    def __init__(self, operation: str, entity: str, identifier: object) -> None:
        super().__init__(
            f"{operation} failed: {entity} identifier={identifier} not found (layer=crud)"
        )
        self.operation = operation
        self.entity = entity
        self.identifier = identifier


class DependencyUnavailableError(ApplicationError):
    """An outbound dependency failed and no fallback could satisfy the call."""

    code = "dependency_unavailable"

    def __init__(self, dependency: str, message: str) -> None:
        super().__init__(message)
        self.dependency = dependency
