'use client';

import { useState, useEffect, useRef } from 'react';
import { ChatMessage } from '@/components/ChatMessage';
import { ChatInput } from '@/components/ChatInput';
import { getOrCreateThreadId, startNewThread } from '@/lib/thread';
import { sendChatMessage } from '@/lib/transport';
import type { UISupervisorMessage, StreamEvent } from '@/lib/types';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

export default function ChatPage() {
  const [messages, setMessages] = useState<UISupervisorMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [threadId, setThreadId] = useState<string>('');
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>();
  const [useMultiAgent, setUseMultiAgent] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setThreadId(getOrCreateThreadId());
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (text: string) => {
    const userMessage: UISupervisorMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      toolCalls: [],  // [수정] Single 모드 tool call 표시용
      tasks: [],
      taskTokens: {},
    };

    const assistantMessage: UISupervisorMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      toolCalls: [],  // [수정] Single 모드 tool call 표시용
      tasks: [],
      taskTokens: {},
    };

    setMessages(prev => [...prev, userMessage, assistantMessage]);
    setIsStreaming(true);
    setActiveTaskId(undefined);

    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    const endpoint = useMultiAgent ? '/chat/supervisor/stream' : '/chat/stream';

    try {
      await sendChatMessage(
        BACKEND_URL,
        endpoint,
        text,
        threadId,
        (event: StreamEvent) => {
          // [수정] activeTaskId 갱신을 setMessages 밖으로 이동 (updater 안에서 다른 state를 바꾸지 않음).
          // 완료 시에는 함수형 갱신으로 현재 값과 비교 (가이드는 handleSubmit 시점의 activeTaskId(undefined)와
          // 비교해서 조건이 항상 거짓 → 완료된 task가 다음 task 시작이나 스트림 종료 전까지 active로 남음)
          if (event.type === 'task_started') {
            setActiveTaskId(event.task_id);
          } else if (event.type === 'task_completed') {
            setActiveTaskId(prev => (prev === event.task_id ? undefined : prev));
          }

          // [수정] 기존 메시지 객체를 직접 고치지 않고 새 객체로 교체 (a20과 같은 이유:
          // 개발 모드 Strict Mode가 updater를 두 번 실행해 token·taskTokens가 두 번씩 붙음)
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            const lastMsg = updated[lastIdx];

            switch (event.type) {
              case 'token':
                updated[lastIdx] = { ...lastMsg, content: lastMsg.content + event.content };
                break;

              // [수정] Single 모드 tool call 처리 (가이드: 없음)
              case 'tool_call_start':
                updated[lastIdx] = {
                  ...lastMsg,
                  toolCalls: [
                    ...lastMsg.toolCalls,
                    { toolName: event.tool_name, args: event.args, status: 'pending' },
                  ],
                };
                break;

              case 'tool_call_end': {
                const pendingIdx = lastMsg.toolCalls.findLastIndex(
                  tc => tc.toolName === event.tool_name && tc.status === 'pending'
                );
                if (pendingIdx !== -1) {
                  const toolCalls = [...lastMsg.toolCalls];
                  toolCalls[pendingIdx] = { ...toolCalls[pendingIdx], status: 'completed', result: event.result };
                  updated[lastIdx] = { ...lastMsg, toolCalls };
                }
                break;
              }

              case 'plan_created':
                updated[lastIdx] = { ...lastMsg, plan: event.plan };
                break;

              case 'task_list_created':
                updated[lastIdx] = { ...lastMsg, tasks: event.tasks };
                break;

              case 'task_started':
                updated[lastIdx] = {
                  ...lastMsg,
                  tasks: lastMsg.tasks.map(t =>
                    t.id === event.task_id
                      ? { ...t, status: 'in_progress' as const }
                      : t
                  ),
                };
                break;

              case 'task_completed':
                updated[lastIdx] = {
                  ...lastMsg,
                  tasks: lastMsg.tasks.map(t =>
                    t.id === event.task_id
                      ? { ...t, status: 'completed' as const, result: event.result_preview }
                      : t
                  ),
                };
                break;

              case 'sub_agent_token':
                updated[lastIdx] = {
                  ...lastMsg,
                  taskTokens: {
                    ...lastMsg.taskTokens,
                    [event.task_id]: (lastMsg.taskTokens[event.task_id] || '') + event.content,
                  },
                };
                break;

              case 'done':
                break;
            }

            return updated;
          });
        },
        abortControllerRef.current.signal,
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Stream error:', error);
      }
    } finally {
      setIsStreaming(false);
      setActiveTaskId(undefined);
    }
  };

  const handleNewThread = () => {
    abortControllerRef.current?.abort();
    setMessages([]);
    setThreadId(startNewThread());
    setActiveTaskId(undefined);
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      <header className="flex justify-between items-center p-4 border-b">
        <div>
          <h1 className="text-xl font-bold">ICT 운영 지원 Agent</h1>
          <label className="flex items-center gap-2 mt-2 text-sm">
            <input
              type="checkbox"
              checked={useMultiAgent}
              onChange={(e) => setUseMultiAgent(e.target.checked)}
            />
            Multi-Agent 모드 (Supervisor)
          </label>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-500">
            Thread: {threadId.slice(0, 8)}...
          </span>
          <button
            onClick={handleNewThread}
            className="px-3 py-1 text-sm border rounded hover:bg-gray-100"
          >
            새 대화
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div className="text-center text-gray-400 mt-20">
            메시지를 입력하여 대화를 시작하세요.
          </div>
        ) : (
          messages.map(msg => (
            <ChatMessage
              key={msg.id}
              message={msg}
              activeTaskId={activeTaskId}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </main>

      <ChatInput onSubmit={handleSubmit} disabled={isStreaming} />
    </div>
  );
}
