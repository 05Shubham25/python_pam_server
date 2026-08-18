from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
import redis.asyncio as redis
from app.broker.manager import broker_manager
from app.broker.streamer import SessionStreamer
from app.infrastructure.redis_client import get_redis
import asyncio
import logging

log = logging.getLogger("broker")
router = APIRouter()

@router.websocket("/ws/browser/{session_id}")
async def browser_ws(websocket: WebSocket, session_id: str, r: redis.Redis = Depends(get_redis)):
    log.info("browser ws connecting: session=%s origin=%s", session_id, websocket.headers.get("origin", "?"))
    await broker_manager.connect_browser(websocket, session_id)
    log.info("browser ws accepted: session=%s", session_id)
    streamer = SessionStreamer(r, session_id)

    async def receive_input():
        """Browser → Redis input stream."""
        try:
            while True:
                data = await websocket.receive_bytes()
                await streamer.publish_input(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.debug("browser receive_input ended: %s", e)

    async def send_output():
        """Redis output stream → browser."""
        try:
            async for data in streamer.consume_stream(streamer.output_stream, "browser-group"):
                log.debug("browser ws sending %d bytes to session=%s", len(data), session_id)
                await websocket.send_bytes(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.info("browser send_output ended: %s", e)

    t_in  = asyncio.create_task(receive_input())
    t_out = asyncio.create_task(send_output())
    # Wait for either side to finish then cancel the other
    done, pending = await asyncio.wait(
        [t_in, t_out], return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    broker_manager.disconnect_browser(session_id)
    log.info("browser ws closed: session=%s", session_id)

@router.websocket("/ws/agent/{agent_id}")
async def agent_ws(websocket: WebSocket, agent_id: str, r: redis.Redis = Depends(get_redis)):
    await broker_manager.connect_agent(websocket, agent_id)
    # Agent sends session_id as first text message to bind streams.
    # If it connects with no active session it will close immediately — that's normal.
    try:
        session_id = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        log.info("agent %s bound to session %s", agent_id, session_id)
    except asyncio.TimeoutError:
        log.warning("agent %s connected but sent no session_id within 10s — closing", agent_id)
        broker_manager.disconnect_agent(agent_id)
        await websocket.close(code=1008)
        return
    except WebSocketDisconnect as e:
        log.info("agent %s disconnected before sending session_id (code=%s) — no active session?", agent_id, e.code)
        broker_manager.disconnect_agent(agent_id)
        return

    streamer = SessionStreamer(r, session_id)

    async def receive_output():
        """Agent → Redis output stream."""
        try:
            while True:
                data = await websocket.receive_bytes()
                await streamer.publish_output(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.debug("agent receive_output ended: %s", e)

    async def send_input():
        """Redis input stream → agent."""
        try:
            async for data in streamer.consume_stream(streamer.input_stream, "agent-group"):
                await websocket.send_bytes(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.debug("agent send_input ended: %s", e)

    t_out = asyncio.create_task(receive_output())
    t_in  = asyncio.create_task(send_input())
    done, pending = await asyncio.wait(
        [t_out, t_in], return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    broker_manager.disconnect_agent(agent_id)
    log.info("agent ws closed: %s (session %s)", agent_id, session_id)

