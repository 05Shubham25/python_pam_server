from fastapi import APIRouter
from app.api.v1.endpoints import agent, auth, broker_ws, hosts, sessions

api_router = APIRouter()
api_router.include_router(auth.router, tags=["Auth"])
api_router.include_router(agent.router, tags=["Agent"])
api_router.include_router(hosts.router, tags=["Hosts"])
api_router.include_router(sessions.router, tags=["Sessions"])
api_router.include_router(broker_ws.router, tags=["WebSocket Broker"])
