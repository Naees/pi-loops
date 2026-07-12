# Current-Model Evaluator Spike

**Date:** 2026-07-12  
**Result:** Passed on the development Pi installation

## Purpose

Verify that a Pi extension can use the currently selected model and existing Pi authentication for a fresh, tool-free completion evaluation without separate provider setup.

## Method

A temporary internal extension created `CurrentModelEvaluator` from `src/evidence/evaluator.ts` inside an RPC command context. It supplied one passing deterministic criterion and required a strict JSON decision.

## Result

```json
{
  "complete": true,
  "needsUser": false,
  "reason": "The supplied verifier evidence explicitly reports that the controlled deterministic check passed.",
  "failedCriteria": [],
  "feedback": null
}
```

The adapter successfully:

- Found the currently selected Pi model.
- Resolved existing authentication through `ctx.modelRegistry.getApiKeyAndHeaders()`.
- Called `@earendil-works/pi-ai/compat` `complete()` in fresh context.
- Received and strictly parsed the required JSON shape.

## Remaining evaluator work

- Bound every input field before provider submission.
- Add cancellation-race tests proving a late response cannot restart a cancelled run.
- Add controlled reject, needs-user, malformed-output, provider-error, and rate-limit integration cases.
- Record usage without persisting credentials or environment values.
