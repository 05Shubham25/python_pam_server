import asyncio
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
        now = time.monotonic()
        if now - self._last_expire < 1.0:
            return
        self._last_expire = now
        for s in streams:
            await self.redis.expire(s, self.STREAM_TTL_SECONDS)

    async def publish_input(self, data: bytes):
        """Browser keystrokes -> Input Stream (raw bytes)"""
        await self.redis.xadd(self.input_stream, {"data": data})
        await self._touch_ttl(self.input_stream)

    async def publish_output(self, data: bytes):
        """Agent screen/terminal -> Output Stream -> Browser"""
        await self.redis.xadd(self.output_stream, {"data": data})
        await self._touch_ttl(self.output_stream)

    async def consume_stream(self, stream_name: str, consumer_group: str = "default"):
        """Reads from a stream continuously from 0-0 onwards (used by WebSocket loops)."""
        def _payload(msg_data) -> bytes:
            val = msg_data.get(b"data") if b"data" in msg_data else msg_data.get("data")
            if isinstance(val, bytes):
                return val
            if isinstance(val, str):
                try:
                    return bytes.fromhex(val)
                except ValueError:
                    return val.encode("latin1")
            return b""

        last_id = "0-0"
        while True:
            try:
                results = await self.redis.xread({stream_name: last_id}, count=64, block=100)
                if not results:
                    await asyncio.sleep(0.01)
                    continue
                for _stream, messages in results:
                    for msg_id, msg_data in messages:
                        last_id = msg_id
                        payload = _payload(msg_data)
                        if payload:
                            yield payload
            except asyncio.CancelledError:
                break
            except Exception:
                await asyncio.sleep(0.1)
