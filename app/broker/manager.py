from fastapi import WebSocket
from app.broker.streamer import SessionStreamer

class ConnectionManager:
    """Manages active WebSocket connections and links them to Redis Streams."""
    
    def __init__(self):
        self.active_browsers: dict[str, WebSocket] = {}
        self.active_agents: dict[str, WebSocket] = {}

    async def connect_browser(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_browsers[session_id] = websocket

    async def connect_agent(self, websocket: WebSocket, agent_id: str):
        await websocket.accept()
        self.active_agents[agent_id] = websocket

    def disconnect_browser(self, session_id: str):
        self.active_browsers.pop(session_id, None)

    def disconnect_agent(self, agent_id: str):
        self.active_agents.pop(agent_id, None)

broker_manager = ConnectionManager()
