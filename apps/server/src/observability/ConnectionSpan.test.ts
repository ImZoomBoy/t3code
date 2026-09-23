import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as Socket from "effect/unstable/socket/Socket";

import * as ConnectionSpan from "./ConnectionSpan.ts";

const PING_FRAME = JSON.stringify(RpcMessage.constPing);
const PONG_FRAME = JSON.stringify(RpcMessage.constPong);

// `Tracer.Tracer` is read off the current fiber, not resolved from Context, so a test tracer has to
// be installed with `Effect.withTracer` around the effect under test rather than through a layer.
function collectingTracer(spans: Array<Tracer.NativeSpan>): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
}

const connectionSpan = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
  spans.find((span) => span.name === ConnectionSpan.CLIENT_SOCKET_SPAN_NAME);

/**
 * A socket whose reader stays open until the test ends it, standing in for the platform websocket
 * the RPC server would otherwise be handed. `pull` parks until a frame arrives or the connection
 * fails, which is the contract a real socket reader keeps.
 */
const makeFakeSocket = Effect.fnUntraced(function* () {
  const failed = yield* Deferred.make<never, Socket.SocketError>();
  const written: Array<Uint8Array | string | Socket.CloseEvent> = [];
  const inbound: Array<string | Uint8Array> = [];
  let arrived = yield* Deferred.make<void>();

  const pull = Effect.gen(function* () {
    while (inbound.length === 0) {
      yield* Effect.raceFirst(Deferred.await(failed), Deferred.await(arrived));
      arrived = yield* Deferred.make<void>();
    }
    return inbound.splice(0, inbound.length) as unknown as readonly [
      string | Uint8Array,
      ...Array<string | Uint8Array>,
    ];
  });

  const socket = Socket.make({
    reader: Effect.succeed({ pull, upgrade: () => Effect.void }),
    writer: Effect.succeed({
      write: (chunk: Uint8Array | string | Socket.CloseEvent) =>
        Effect.sync(() => {
          written.push(chunk);
        }),
      writeAll: (chunks: readonly [Uint8Array | string, ...Array<Uint8Array | string>]) =>
        Effect.sync(() => {
          written.push(...chunks);
        }),
    }),
  });

  return {
    socket,
    written,
    // Returns once the reader has taken the frame, so the test controls the order of
    // arrivals and clock moves exactly.
    receive: (data: string) =>
      Effect.gen(function* () {
        inbound.push(data);
        yield* Deferred.succeed(arrived, undefined);
        while (inbound.length > 0) {
          yield* Effect.yieldNow;
        }
        yield* Effect.yieldNow;
      }),
    closeWith: (code: number, closeReason?: string) =>
      Deferred.failSync(
        failed,
        () =>
          new Socket.SocketError({
            reason: new Socket.SocketCloseError(
              closeReason === undefined ? { code } : { code, closeReason },
            ),
          }),
      ),
  };
});

/** Reads the instrumented socket, hands the test a writer, and returns once the read has started. */
const startSocket = Effect.fnUntraced(function* (fake: { readonly socket: Socket.Socket }) {
  const instrumented = yield* ConnectionSpan.instrumentClientSocket(fake.socket, {
    attributes: { "connection.session.id": "session-1" },
  });
  const writer = yield* instrumented.writer;
  const fiber = yield* Effect.forkChild(
    Effect.exit(
      Effect.gen(function* () {
        const reader = yield* instrumented.reader;
        while (true) {
          yield* reader.pull;
        }
      }).pipe(Effect.scoped),
    ),
  );
  yield* Effect.yieldNow;
  return { fiber, write: writer.write };
});

describe("instrumentClientSocket", () => {
  it.effect("records a clean close with its code, reason and keepalive counts", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    return Effect.gen(function* () {
      const fake = yield* makeFakeSocket();
      const { fiber, write } = yield* startSocket(fake);

      yield* fake.receive(PING_FRAME);
      yield* write(PONG_FRAME);
      yield* TestClock.adjust("5 seconds");
      yield* fake.receive(PING_FRAME);
      yield* write(PONG_FRAME);

      yield* fake.closeWith(1000, "going away");
      yield* Fiber.join(fiber);

      const span = connectionSpan(spans);
      expect(span?.status._tag).toBe("Ended");
      expect(span?.attributes.get("connection.session.id")).toBe("session-1");
      expect(span?.attributes.get("connection.close.observed")).toBe(true);
      expect(span?.attributes.get("connection.close.code")).toBe(1000);
      expect(span?.attributes.get("connection.close.reason")).toBe("going away");
      expect(span?.attributes.get("connection.close.clean")).toBe(true);
      expect(span?.attributes.get("connection.close.initiator")).toBe("client");
      expect(span?.attributes.get("connection.ping.count")).toBe(2);
      expect(span?.attributes.get("connection.pong.count")).toBe(2);
      expect(span?.attributes.get("connection.ping.lastAgeMs")).toBe(0);
      expect(span?.attributes.get("connection.pong.lastAgeMs")).toBe(0);
      expect(span?.attributes.get("connection.ping.starved")).toBe(false);
      expect(span?.attributes.get("connection.open.durationMs")).toBe(5000);
    }).pipe(
      Effect.withTracer(collectingTracer(spans)),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    );
  });

  it.effect("records an abnormal close as unclean with no reason", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    return Effect.gen(function* () {
      const fake = yield* makeFakeSocket();
      const { fiber } = yield* startSocket(fake);

      // 1006 is what a dropped transport leaves behind: no close frame, so no reason either.
      yield* fake.closeWith(1006);
      yield* Fiber.join(fiber);

      const span = connectionSpan(spans);
      expect(span?.status._tag).toBe("Ended");
      expect(span?.attributes.get("connection.close.observed")).toBe(true);
      expect(span?.attributes.get("connection.close.code")).toBe(1006);
      expect(span?.attributes.get("connection.close.reason")).toBe("");
      expect(span?.attributes.get("connection.close.clean")).toBe(false);
      expect(span?.attributes.get("connection.close.initiator")).toBe("client");
      expect(span?.attributes.get("connection.ping.count")).toBe(0);
      expect(span?.attributes.get("connection.ping.lastAgeMs")).toBeNull();
      expect(span?.attributes.get("connection.pong.lastAgeMs")).toBeNull();
    }).pipe(
      Effect.withTracer(collectingTracer(spans)),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    );
  });

  it.effect("reports keepalive starvation when the client stops asking for pongs", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    return Effect.gen(function* () {
      const fake = yield* makeFakeSocket();
      const { fiber, write } = yield* startSocket(fake);

      yield* fake.receive(PING_FRAME);
      yield* write(PONG_FRAME);

      // The client stops pinging for far longer than its 5-second interval, which is what a
      // client-side missed pong looks like from this end.
      yield* TestClock.adjust("25 seconds");
      yield* fake.receive(PING_FRAME);
      yield* TestClock.adjust("25 seconds");

      yield* fake.closeWith(1006);
      yield* Fiber.join(fiber);

      const span = connectionSpan(spans);
      expect(span?.attributes.get("connection.ping.starved")).toBe(true);
      expect(span?.attributes.get("connection.ping.maxGapMs")).toBe(25_000);
      expect(span?.attributes.get("connection.ping.lastAgeMs")).toBe(25_000);
      expect(span?.attributes.get("connection.pong.lastAgeMs")).toBe(50_000);
      expect(span?.attributes.get("connection.ping.count")).toBe(2);
      expect(span?.attributes.get("connection.pong.count")).toBe(1);

      const gaps = span?.events.filter(([name]) => name.endsWith("keepaliveGap")) ?? [];
      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.[2]).toMatchObject({ "connection.ping.gapMs": 25_000 });
    }).pipe(
      Effect.withTracer(collectingTracer(spans)),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    );
  });

  it.effect("names the environment as the initiator when it sends the close frame", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    return Effect.gen(function* () {
      const fake = yield* makeFakeSocket();
      const { fiber, write } = yield* startSocket(fake);

      yield* write(new Socket.CloseEvent(1001, "server shutting down"));
      yield* Fiber.interrupt(fiber);

      const span = connectionSpan(spans);
      expect(span?.attributes.get("connection.close.initiator")).toBe("server");
      // The read was interrupted rather than failing, so there is no close error to read a
      // code from.
      expect(span?.attributes.get("connection.close.observed")).toBe(false);
      expect(span?.attributes.get("connection.close.clean")).toBe(true);
    }).pipe(
      Effect.withTracer(collectingTracer(spans)),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    );
  });

  it.effect("ends the span even when the connection scope closes before the run starts", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    return Effect.gen(function* () {
      const fake = yield* makeFakeSocket();
      yield* Effect.scoped(ConnectionSpan.instrumentClientSocket(fake.socket));

      expect(connectionSpan(spans)?.status._tag).toBe("Ended");
    }).pipe(Effect.withTracer(collectingTracer(spans)), Effect.provide(TestClock.layer()));
  });
});

describe("clientConnectionTrace", () => {
  const requestFor = (url: string) => HttpServerRequest.fromWeb(new Request(url));

  it("parents the connection on the span the client put on the URL", () => {
    const trace = ConnectionSpan.clientConnectionTrace(
      requestFor(
        "https://environment.example.test/ws?wsTicket=t&traceparent=00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      ),
    );

    expect(trace.parent?.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(trace.parent?.spanId).toBe("0123456789abcdef");
    expect(trace.parent?.sampled).toBe(true);
    expect(trace.attributes).toEqual({ "connection.id": "0123456789abcdef" });
  });

  it("ignores a missing or malformed traceparent", () => {
    expect(
      ConnectionSpan.clientConnectionTrace(requestFor("https://environment.example.test/ws")),
    ).toEqual({ attributes: {} });
    expect(
      ConnectionSpan.clientConnectionTrace(
        requestFor("https://environment.example.test/ws?traceparent=nonsense"),
      ),
    ).toEqual({ attributes: {} });
  });
});
