#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Reproduce the currently pinned RC.3 report with fresh local proofs.
import {runReviewCommand} from '../../scripts/review/run.mjs';
await runReviewCommand('native');
