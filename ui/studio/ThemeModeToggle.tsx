import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { type StudioThemeMode, useStudio } from "./context";

const THEME_OPTIONS: Array<{
  icon: typeof Sun;
  label: string;
  value: StudioThemeMode;
}> = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
];

function isThemeMode(value: string): value is StudioThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Always-visible light / dark / system theme picker in the Studio header.
 * Uses the same persisted theme state as the command palette.
 */
export function ThemeModeToggle() {
  const { isDarkMode, setThemeMode, themeMode } = useStudio();
  const TriggerIcon = isDarkMode ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Theme"
          data-testid="studio-theme-toggle"
          size="icon"
          title="Theme"
          variant="outline"
        >
          <TriggerIcon data-icon="inline-start" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36 font-sans">
        <DropdownMenuLabel className="text-xs">Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={themeMode}
          onValueChange={(value) => {
            if (isThemeMode(value)) setThemeMode(value);
          }}
        >
          {THEME_OPTIONS.map(({ icon: Icon, label, value }) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              className="text-xs"
            >
              <Icon className="size-3.5" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
