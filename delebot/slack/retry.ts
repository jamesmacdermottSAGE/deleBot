/** Retry only a failed Slack call, never a task mutation or an uncertain message send. */
export async function retrySlack<T extends { ok: boolean; error?: string }>(
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      const result = await call();
      if (result.ok) return result;
      console.warn(
        JSON.stringify({
          event: "slack_call_failed",
          operation,
          error: result.error ?? "invalid_response",
        }),
      );
      if (
        attempt ||
        !["internal_error", "service_unavailable", "fatal_error", "request_timeout"]
          .includes(result.error ?? "")
      ) return result;
    } catch (error) {
      if (attempt) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
