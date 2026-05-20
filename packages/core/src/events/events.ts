/**
 * Core domain events for InkOS pipeline.
 *
 * These events decouple producers (PipelineRunner, Scheduler) from
 * consumers (webhook notifier, metrics collector, circuit breaker,
 * adaptive gate, etc.).
 */

import type { AuditResult } from "../agents/continuity.js";

export interface ChapterDraftedEvent {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly status: "drafted";
}

export interface ChapterAuditedEvent {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly passed: boolean;
  readonly overallScore?: number;
  readonly issueCount: number;
}

export interface ChapterRevisedEvent {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly applied: boolean;
  readonly fixedCount: number;
}

export interface AuditFailedEvent {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly auditResult: AuditResult;
}

export interface BookPausedEvent {
  readonly bookId: string;
  readonly reason: string;
  readonly consecutiveFailures: number;
}

export interface BookResumedEvent {
  readonly bookId: string;
}

export interface PipelineErrorEvent {
  readonly bookId: string;
  readonly chapterNumber?: number;
  readonly error: string;
}

export const INKOS_EVENTS = {
  CHAPTER_DRAFTED: "chapter:drafted",
  CHAPTER_AUDITED: "chapter:audited",
  CHAPTER_REVISED: "chapter:revised",
  AUDIT_FAILED: "audit:failed",
  BOOK_PAUSED: "book:paused",
  BOOK_RESUMED: "book:resumed",
  PIPELINE_ERROR: "pipeline:error",
} as const;
