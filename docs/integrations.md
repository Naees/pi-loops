# Pi Loops integration contract

Pi Loops does not bundle vendor-specific CI, GitHub, Slack, webhook, polling, or credential adapters. Other Pi extensions may request a previously confirmed event trigger through Pi's shared event bus.

## Event name

```text
pi-loops:trigger
```

## Payload

```ts
interface PiLoopsTriggerEventV1 {
  schemaVersion: 1;
  triggerId: `trigger_${string}`;
  eventId?: string;
}
```

Example:

```ts
pi.events.emit("pi-loops:trigger", {
  schemaVersion: 1,
  triggerId: "trigger_a4f2c1d3",
  eventId: "build-42",
});
```

The trigger must already exist, be project-bound, user-confirmed, enabled, and use the event source created by:

```text
/loops watch event -- <goal>
```

## Security properties

The payload is a strict allowlist. It cannot provide or override:

- Goal or constraints
- Verifier commands
- Budget
- Project or filesystem path
- Shell command
- Provider/model credentials
- Environment variables
- Git branch or worktree

Unknown fields, malformed IDs, unsupported schema versions, and oversized/empty event IDs are rejected. Event errors are rate-limited before reaching UI notifications.

An optional `eventId` is deduplicated for the current Pi process. Pi Loops remembers at most 128 IDs per trigger. Delivery is bounded to one current and one pending event per definition, with process-local admission for at most 64 trigger keys. Duplicate delivery remains possible across process restarts, so adapters should use stable event IDs when available and goals must be safe to reevaluate.

## Lifecycle

Event delivery is active only while Pi is running in the bound project. Pi Loops does not listen on a network port and does not replay events received while Pi is closed. Closing Pi deactivates the relay and stops active local occurrences.

## Model-facing trigger action

The `pi_loops` tool can fire an existing confirmed trigger ID. It follows the same stored definition and cannot inject event-specific goals, paths, budgets, commands, or credentials.

## Adapter guidance

External adapters should:

1. Authenticate and validate vendor events outside Pi Loops.
2. Map the external event to an existing confirmed trigger ID.
3. Emit only the version-one payload above.
4. Use a stable, non-secret `eventId` of at most 128 characters.
5. Avoid embedding payload bodies, tokens, URLs with credentials, or personal data in `eventId`.
6. Do not assume exactly-once delivery or that every event starts a new writer.

Adapter credentials remain the responsibility of the adapter and Pi's normal environment/permission model. Pi Loops neither stores nor requests them.
