"""widen analysis_source for multilingual_local

Phase 3 introduces a third analyzer whose `source` value is "multilingual_local" —
18 characters against a varchar(16) column. Every write failed with
StringDataRightTruncationError, which surfaced as an ARQ job crash rather than as a
validation error, leaving rows stuck in `pending`.

Widened to 32 rather than 18 so the next analyzer name does not need another
migration. Purely a length change: no data is rewritten and existing values are
unaffected.

Revision ID: c7d1a4f92b30
Revises: 2e3a7f4d4c99
Create Date: 2026-07-28

"""

import sqlalchemy as sa
from alembic import op

revision = "c7d1a4f92b30"
down_revision = "2e3a7f4d4c99"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "messages",
        "analysis_source",
        existing_type=sa.String(length=16),
        type_=sa.String(length=32),
        existing_nullable=True,
    )


def downgrade() -> None:
    # Any row written by the Phase 3 analyzer is too long for the old column, so
    # narrowing would fail on live data. Clear those rows first: analysis is
    # reproducible and additive, and losing it is the intended cost of a downgrade.
    op.execute("UPDATE messages SET analysis_source = NULL WHERE length(analysis_source) > 16")
    op.alter_column(
        "messages",
        "analysis_source",
        existing_type=sa.String(length=32),
        type_=sa.String(length=16),
        existing_nullable=True,
    )
