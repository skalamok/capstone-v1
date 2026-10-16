/**
 * 단일 chat 메시지 렌더링.
 *
 * Single agent: token stream + tool call
 * Multi-agent: Plan 카드 + Task 목록 + 최종 응답
 */

import type { UISupervisorMessage } from '@/lib/types';
import { PlanView } from './PlanView';
import { TaskListView } from './TaskListView';
import { ToolCallView } from './ToolCallView';

interface Props {
  message: UISupervisorMessage;
  activeTaskId?: string;
}

export function ChatMessage({ message, activeTaskId }: Props) {
  const isUser = message.role === 'user';

  return (
    <div className={`my-4 ${isUser ? 'text-right' : 'text-left'}`}>
      <div className="text-xs text-gray-500 mb-1">
        {isUser ? '사용자' : 'AI Agent'}
      </div>

      <div className={`inline-block max-w-3xl p-3 rounded ${
        isUser
          ? 'bg-gray-200 text-black'
          : 'bg-white border border-gray-300'
      }`}>
        {/* [수정] Single 모드 tool call 박스 (가이드: a21에서 빠짐 → Single 모드에서 도구 박스가 사라짐) */}
        {message.toolCalls.map((tc, i) => (
          <ToolCallView key={i} toolCall={tc} />
        ))}

        {/* Plan 카드 (multi-agent 전용) */}
        {message.plan && <PlanView plan={message.plan} />}

        {/* Task list (multi-agent 전용) */}
        {message.tasks.length > 0 && (
          <TaskListView
            tasks={message.tasks}
            taskTokens={message.taskTokens}
            activeTaskId={activeTaskId}
          />
        )}

        {/* 최종 응답 token */}
        {message.content && (
          <div className="mt-3 whitespace-pre-wrap border-t pt-3">
            {message.content}
          </div>
        )}
      </div>
    </div>
  );
}
