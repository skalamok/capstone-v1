"""
FastAPI backend 진입점.

- POST /chat: 단순 request/response
- 에러 처리는 graceful degradation 없이 처리
"""
import uuid
from fastapi import FastAPI, HTTPException
from contextlib import asynccontextmanager
# [추가] 프로젝트 루트의 .env(OPENAI_API_KEY, LANGSMITH_*)를 환경변수로 읽음. 교수님 코드는 a32부터 같은 방식
import os
from pathlib import Path
from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"

# load_dotenv는 파일이 없거나 비어 있으면 False → 실행 방법 안내
if not load_dotenv(ENV_PATH):
    key_state = "있음 (셸에서 설정됨, 그대로 실행 가능)" if os.getenv("OPENAI_API_KEY") else "없음 (agent 생성 시 실패)"
    print(
        f"[경고] .env를 찾지 못했습니다: {ENV_PATH}\n"
        f"  OPENAI_API_KEY 환경변수: {key_state}\n"
        f"  해결 1) 위 경로에 .env 파일을 만들고 OPENAI_API_KEY=... 를 적는다\n"
        f"  해결 2) .env 위치를 직접 지정해 실행한다 (backend 폴더에서)\n"
        f"    uv run --env-file <.env 경로> uvicorn main:app --reload --port 8000"
    )

from agent.graph import build_agent
from schemas.chat import ChatRequest, ChatResponse
from fastapi.responses import StreamingResponse
from streaming.sse_formatter import format_sse
from streaming.event_converter import convert_langgraph_events


# Agent를 lifespan으로 1회 생성 (서버 시작 시)
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: agent 생성
    app.state.agent = await build_agent()
    yield
    # Shutdown: 별도 정리 필요시 여기에


app = FastAPI(
    title="ICT Operations Support Backend",
    description="Capstone Day 1 — RAG + Agent + MCP integrated backend",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """
    사용자 메시지를 받아 agent로 처리.

    단일 요청 - 응답 (streaming 다음에 고려함)
    """
    # thread_id 처리 (없으면 새로 생성)
    thread_id = request.thread_id or str(uuid.uuid4())

    # Agent 호출
    # 에러 처리: 실패 시 그대로 전파
    config = {"configurable": {"thread_id": thread_id}}

    result = await app.state.agent.ainvoke(
        {"messages": [{"role": "user", "content": request.message}]},
        config=config,
    )

    # 응답 메시지 추출
    final_message = result["messages"][-1]

    # Tool calls 추출 (디버깅용)
    tool_calls = []
    for msg in result["messages"]:
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls.append({
                    "name": tc["name"],
                    "args": tc["args"],
                })

    return ChatResponse(
        thread_id=thread_id,
        message=final_message.content,
        tool_calls=tool_calls,
    )


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    Streaming chat endpoint.

    추가:
    - SSE (Server-Sent Events) format으로 stream
    - 4가지 event type: token, tool_call_start, tool_call_end, done
    - Multi-event streaming
    """
    # thread_id 처리 (Day 1과 동일 로직)
    thread_id = request.thread_id or str(uuid.uuid4())

    async def event_generator():
        """
        SSE event를 생성하는 async generator.
        FastAPI StreamingResponse가 이를 chunk 단위로 client에 전송.
        """
        config = {"configurable": {"thread_id": thread_id}}

        # LangGraph astream 호출
        langgraph_stream = app.state.agent.astream(
            {"messages": [{"role": "user", "content": request.message}]},
            config=config,
            stream_mode=["messages", "updates"],
        )

        # LangGraph event → 본 capstone event → SSE format
        async for event in convert_langgraph_events(langgraph_stream, thread_id):
            yield format_sse(event)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            # Proxy/Load Balancer buffering 방지
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
