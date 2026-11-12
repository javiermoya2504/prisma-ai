import { Sparkles } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useUiState } from "../../hooks/use-ui-state";
import { useStudio } from "../context";
import { ASSISTANT_PANEL_STATE_KEY } from "./StudioAssistantPanel";

/**
 * Floating round button in the bottom-right corner of the Studio shell that
 * opens the AI assistant next to the current view (it never changes the
 * view). It hides while the panel is open.
 */
export function StudioAssistantLauncher() {
  const { aiSettings, hasAiSql, hasDatabase } = useStudio();
  const [isOpen, setIsOpen] = useUiState(ASSISTANT_PANEL_STATE_KEY, false, {
    persistent: true,
  });

  if (!hasDatabase || !(hasAiSql || aiSettings) || isOpen) {
    return null;
  }

  return (
    <Button
      type="button"
      size="icon"
      aria-label="Open AI assistant"
      title="AI assistant"
      className="absolute right-5 bottom-20 z-20 size-12 rounded-full shadow-lg transition-transform hover:scale-105"
      onClick={() => setIsOpen(true)}
    >
      <Sparkles className="size-5" />
    </Button>
  );
}
