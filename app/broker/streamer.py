import redis.asyncio as redis
import time
import uuid

class SessionStreamer:
    """Handles routing data through Redis Streams for backpressure and recording."""

    # Streams self-destruct if nobody consumes them (orphaned sessions)
    STREAM_TTL_SECONDS = 3600

    def __init__(self, redis: redis.Redis, session_id: str):
        self.redis = redis
        self.session_id = session_id
        # Streams for browser->agent (input) and agent->browser (output)
        self.input_stream = f"session:{session_id}:input"
        self.output_stream = f"session:{session_id}:output"
        self._last_expire = 0.0

    async def _touch_ttl(self, *streams: str) -> None:
        # refreshing TTL on every frame is wasteful at 30+ fps — once per
        # second per session is plenty
        now = time.monotonic()
        if now - self._last_expire < 1.0:
            return
        self._last_expire = now
        for s in streams:
            await self.redis.expire(s, self.STREAM_TTL_SECONDS)

    async def publish_input(self, data: bytes):
        """Browser keystrokes -> Input Stream (raw bytes, not hex)"""
        await self.redis.xadd(self.input_stream, {"data": data})
        await self._touch_ttl(self.input_stream)

    async def publish_output(self, data: bytes):
        """Agent screen/terminal -> Output Stream -> (Browser + Recording Worker)"""
        await self.redis.xadd(self.output_stream, {"data": data})
        await self._touch_ttl(self.output_stream)

    async def consume_stream(self, stream_name: str, consumer_group: str):
        """Reads from a stream continuously (used by WebSocket loops).

        Strategy:
          1. Create the consumer group at id="0" so any messages already in
             the stream (e.g. a 'bye' sent before the browser WS connected)
             are visible as pending.
          2. Drain the backlog with id="0" first.
          3. Switch to id=">" to receive new messages going forward.
        """
        # Ensure consumer group exists; "0" means "start from beginning"
        try:
            await self.redis.xgroup_create(stream_name, consumer_group, id="0", mkstream=True)
        except redis.ResponseError:
            pass  # Group already exists — backlog still readable via id="0"

        consumer_name = "worker-1"

        def _payload(msg_data) -> bytes:
            # raw bytes since the 30fps update; hex for older frames already
            # sitting in a stream from a pre-upgrade agent
            val = msg_data["data"]
            return val if isinstance(val, bytes) else bytes.fromhex(val)

        async def _drain_and_forward(read_id: str):
            """Yield messages for a given read id, ack each one."""
            while True:
                results = await self.redis.xreadgroup(
                    consumer_group, consumer_name,
                    {stream_name: read_id}, count=64, block=5,
                )
                if not results:
                    return  # nothing pending / no new messages in this window
                for _stream, messages in results:
                    for msg_id, msg_data in messages:
                        yield _payload(msg_data)
                        await self.redis.xack(stream_name, consumer_group, msg_id)

        # Phase 1: drain backlog (messages already in stream before group joined)
        async for data in _drain_and_forward("0"):
            yield data

        # Phase 2: tail new messages
        while True:
            async for data in _drain_and_forward(">"):
                yield data
            # _drain_and_forward returned with no results — 20ms block expired,
            # loop again to keep polling.
