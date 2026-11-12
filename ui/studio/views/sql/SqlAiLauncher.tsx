import { Sparkles } from "lucide-react";

import { Button } from "../../../components/ui/button";
import { useNavigation } from "../../../hooks/use-navigation";
import { useUiState } from "../../../hooks/use-ui-state";
import { useStudio } from "../../context";
import { SQL_AI_PANEL_STATE_KEY } from "./SqlAiPanel";

/**
 * Floating round button in the bottom-right corner of the Studio shell that
 * opens the AI assistant panel from any view (switching to the SQL view). It
 * hides while the panel is open; the panel's close button brings it back.
 */
export function SqlAiLauncher() {
  const { aiSettings, hasAiSql, hasDatabase } = useStudio();
  const { setViewParam, viewParam } = useNavigation();
  const [isAiPanelOpen, setIsAiPanelOpen] = useUiState(
    SQL_AI_PANEL_STATE_KEY,
    false,
    { persistent: true },
  );

  if (!hasDatabase || !(hasAiSql || aiSettings)) {
    return null;
  }

  if (isAiPanelOpen && viewParam === "sql") {
    return null;
  }

  return (
    <Button
      type="button"
      size="icon"
      aria-label="Open AI assistant"
      title="AI assistant"
      className="absolute right-5 bottom-20 z-20 size-12 rounded-full shadow-lg transition-transform hover:scale-105"
      onClick={() => {
        setIsAiPanelOpen(true);

        if (viewParam !== "sql") {
          void setViewParam("sql");
        }
      }}
    >
      <Sparkles className="size-5" />
    </Button>
  );
}
