import { expect, test } from "bun:test";
import { handleReinterpretation } from "../apps/web/src/server/reinterpretation";

test("early upstream refusals and unexpected statuses discard bodies without changing safe outcomes", async () => {
  for (const method of ["GET", "POST"] as const) {
    for (const status of [400, 401, 403, 404, 413, 415, 201, 500]) {
      for (const cancellation of ["success", "throw", "reject", "pending"] as const) {
        let cancellations = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode("private upstream error")); },
          cancel() {
            cancellations++;
            if (cancellation === "throw") throw new Error("cleanup failure");
            if (cancellation === "reject") return Promise.reject(new Error("cleanup failure"));
            if (cancellation === "pending") return new Promise<void>(() => {});
          },
        });
        const upstream = new Response(stream, {status});
        const request = new Request("http://localhost/api/ideas/subject/reinterpret", method === "POST"
          ? {method, headers:{"content-type":"application/json"}, body:"{}"} : {method});
        const response = await handleReinterpretation(request, "subject", "request-key", {
          callDaemon: async operation => {
            expect(operation.preserveErrorBody).toBe(true);
            return upstream;
          },
        });
        const expected = [400, 401, 403, 404, 413, 415].includes(status) ? status : 502;
        expect(response.status).toBe(expected);
        expect(await response.json()).toEqual({message: expected === 400 ? "Invalid request." : expected === 404 ? "Idea unavailable." : "Unable to confirm outcome."});
        expect(cancellations).toBe(1);
        expect(upstream.bodyUsed).toBe(true);
      }
    }
  }
});
