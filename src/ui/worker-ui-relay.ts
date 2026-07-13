import { errorMessage } from "../shared/errors.js";
import { isRecord } from "../shared/validation.js";

const MAX_UI_TEXT_BYTES = 16 * 1024;
const MAX_UI_OPTIONS = 100;

export interface ParentWorkerUi {
  readonly hasUI: boolean;
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: readonly string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export type WorkerUiRelayResult =
  | { readonly handled: true; readonly response?: Record<string, unknown> }
  | { readonly handled: false; readonly reason: string };

function boundedString(value: unknown): string;
function boundedString(value: unknown, required: false): string | undefined;
function boundedString(value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.trim().length === 0) || Buffer.byteLength(value, "utf8") > MAX_UI_TEXT_BYTES) {
    throw new Error("Worker UI request contains invalid or oversized text");
  }
  return value;
}

function isValidOptions(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_UI_OPTIONS &&
    value.every((option) => typeof option === "string" && option.trim().length > 0 &&
      Buffer.byteLength(option, "utf8") <= MAX_UI_TEXT_BYTES);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("UI relay aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException("UI relay aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function relayWorkerUiRequest(
  value: unknown,
  ui: ParentWorkerUi,
  signal: AbortSignal,
): Promise<WorkerUiRelayResult> {
  if (!isRecord(value) || value.type !== "extension_ui_request" || typeof value.id !== "string" || value.id.length === 0 || typeof value.method !== "string") {
    return { handled: false, reason: "Malformed worker UI request" };
  }
  if (signal.aborted) return { handled: false, reason: "UI relay aborted" };
  try {
    if (value.method === "notify") {
      const message = boundedString(value.message);
      const level = value.notifyType === "warning" || value.notifyType === "error" ? value.notifyType : "info";
      ui.notify(message, level);
      return { handled: true };
    }
    if (!ui.hasUI) return { handled: false, reason: "Worker requested interactive input without a parent UI" };

    if (value.method === "confirm") {
      const confirmed = await abortable(ui.confirm(boundedString(value.title), boundedString(value.message)), signal);
      return { handled: true, response: { type: "extension_ui_response", id: value.id, confirmed } };
    }
    if (value.method === "select") {
      if (!isValidOptions(value.options)) return { handled: false, reason: "Worker select request has invalid options" };
      const selected = await abortable(ui.select(boundedString(value.title), value.options), signal);
      return selected === undefined
        ? { handled: true, response: { type: "extension_ui_response", id: value.id, cancelled: true } }
        : { handled: true, response: { type: "extension_ui_response", id: value.id, value: selected } };
    }
    if (value.method === "input" || value.method === "editor") {
      const title = boundedString(value.title);
      const optional = boundedString(value.method === "input" ? value.placeholder : value.prefill, false);
      const result = value.method === "input"
        ? await abortable(ui.input(title, optional), signal)
        : await abortable(ui.editor(title, optional), signal);
      return result === undefined
        ? { handled: true, response: { type: "extension_ui_response", id: value.id, cancelled: true } }
        : { handled: true, response: { type: "extension_ui_response", id: value.id, value: result } };
    }
    return { handled: false, reason: `Unsupported worker UI method: ${value.method}` };
  } catch (error) {
    return { handled: false, reason: errorMessage(error) };
  }
}
