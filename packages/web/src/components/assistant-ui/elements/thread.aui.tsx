"use client";

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CopyIcon, SquareIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Slots the application fills: actions on each user message, the content
 * of each system message, controls in the composer's action row, and
 * content above the composer.
 */
export type ThreadComponents = {
  UserActions?: ComponentType | undefined;
  SystemItem?: ComponentType | undefined;
  ComposerExtra?: ComponentType | undefined;
  BeforeComposer?: ComponentType | undefined;
};

const ThreadComponentsContext = createContext<ThreadComponents>({});

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

const DefaultToolGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <ToolGroupRoot
      variant="ghost"
      open={open || group.counts.requiresAction > 0}
      onOpenChange={setOpen}
    >
      <ToolGroupTrigger
        count={group.indices.length}
        active={group.status.type === "running"}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const reasoningDuration = (timing: ThreadGroupPart["timing"]) =>
  timing?.completedAt === undefined
    ? undefined
    : Math.round((timing.completedAt - timing.startedAt) / 1000);

export const Thread: FC<{ components?: ThreadComponents }> = ({
  components = {},
}) => {
  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC = () => {
  const { BeforeComposer } = useContext(ThreadComponentsContext);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-bg" as string]:
          "color-mix(in oklab, var(--color-muted) 30%, transparent)",
        ["--composer-radius" as string]: "1rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          <AuiIf condition={(s) => s.thread.messages.length === 0}>
            <ThreadWelcome />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer bg-background sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible rounded-t-(--composer-radius) pb-4 md:pb-6">
            <ThreadScrollToBottom />
            {BeforeComposer ? <BeforeComposer /> : null}
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessage />;
  if (role === "system") return <SystemMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom render={<TooltipIconButton tooltip="Scroll to bottom" variant="outline" className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible" />}><ArrowDownIcon /></ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        What should the agent work on?
      </p>
    </div>
  );
};

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <div
        data-slot="aui_composer-shell"
        className="border-foreground/10 focus-within:border-foreground/25 flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color]"
      >
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="aui-composer-input caret-primary placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
          rows={1}
          autoFocus
          enterKeyHint="send"
          aria-label="Message input"
        />
        <ComposerAction />
      </div>
    </ComposerPrimitive.Root>
  );
};

/** Send stays available while a turn runs, since input steers or queues; stop cancels the turn. */
const ComposerAction: FC = () => {
  const { ComposerExtra } = useContext(ThreadComponentsContext);

  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="aui-composer-action-start flex items-center gap-1.5">
        {ComposerExtra ? <ComposerExtra /> : null}
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel render={<Button type="button" variant="outline" size="icon" className="aui-composer-cancel size-7 rounded-full" aria-label="Stop the turn" />}><SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" /></ComposerPrimitive.Cancel>
        </AuiIf>
        <ComposerPrimitive.Send render={<TooltipIconButton tooltip="Send message" side="bottom" type="button" variant="default" size="icon" className="aui-composer-send size-7 rounded-full" aria-label="Send message" />}><ArrowUpIcon className="aui-composer-send-icon size-4" /></ComposerPrimitive.Send>
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative duration-150"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={messageGroupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                return (
                  <DefaultToolGroup group={part}>{children}</DefaultToolGroup>
                );
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger
                      active={running}
                      duration={reasoningDuration(part.timing)}
                    />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallback {...part} />;
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div data-slot="aui_assistant-message-footer" className="ms-2 flex min-h-7.5 items-center pt-1.5">
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in -ms-1 flex gap-1 duration-200"
        >
          <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Copy" />}><AuiIf condition={(s) => s.message.isCopied}>
              <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
            </AuiIf><AuiIf condition={(s) => !s.message.isCopied}>
              <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
            </AuiIf></ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
};

const UserMessage: FC = () => {
  const { UserActions } = useContext(ThreadComponentsContext);

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-1 px-2 duration-150 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <div className="aui-user-message-content bg-muted text-foreground col-start-2 min-w-0 rounded-(--composer-radius) px-4 py-2 whitespace-pre-wrap wrap-break-word empty:hidden">
        <MessagePrimitive.Parts />
      </div>
      {UserActions ? (
        <div className="aui-user-action-bar-wrapper col-start-2 flex justify-end">
          <UserActions />
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
};

const SystemMessage: FC = () => {
  const { SystemItem } = useContext(ThreadComponentsContext);

  return (
    <MessagePrimitive.Root
      data-slot="aui_system-message-root"
      data-role="system"
      className="text-muted-foreground px-2 text-center text-xs"
    >
      {SystemItem ? <SystemItem /> : <MessagePrimitive.Parts />}
    </MessagePrimitive.Root>
  );
};
