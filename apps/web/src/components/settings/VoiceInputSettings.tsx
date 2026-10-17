import { useState } from "react";
import { SettingsRow, SettingsSection, SettingResetButton } from "./settingsLayout";
import { SecretInput } from "./SecretInput";
import { DraftInput } from "../ui/draft-input";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

export function VoiceInputSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["voiceInput"]);
  const [apiKey, setApiKey] = useState("");
  // Select one environment so changing language cannot copy another environment's secret marker.
  const singleEnvironment = scope.environmentIds.length === 1;
  return (
    <SettingsSection id="voice-input" title="Voice input">
      <SettingsRow
        serverScoped
        settingKeys={["voiceInput"]}
        title="ElevenLabs API key"
        description="Record in the web composer and transcribe with ElevenLabs Scribe. Audio is sent to ElevenLabs after you stop; text stays in your draft until you send. Select one environment to configure."
        resetAction={
          singleEnvironment && settings.voiceInput.apiKey ? (
            <SettingResetButton
              label="ElevenLabs API key"
              onClick={() => {
                setApiKey("");
                updateSettings({ voiceInput: { ...settings.voiceInput, apiKey: "" } });
              }}
            />
          ) : null
        }
        control={
          <SecretInput
            size="sm"
            value={apiKey}
            configured={!mixed && settings.voiceInput.apiKey.length > 0}
            disabled={!singleEnvironment}
            aria-label="ElevenLabs API key"
            onChange={(event) => setApiKey(event.target.value)}
            onCommit={(next) => {
              if (!next.trim()) return;
              updateSettings({ voiceInput: { ...settings.voiceInput, apiKey: next } });
              setApiKey("");
            }}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["voiceInput"]}
        title="Transcription language"
        description="Leave empty for automatic detection, or enter a language code such as en or bg. Recordings stop after five minutes."
        control={
          <DraftInput
            size="sm"
            value={mixed ? "" : settings.voiceInput.language}
            disabled={!singleEnvironment}
            maxLength={3}
            placeholder="Automatic"
            aria-label="Transcription language"
            onCommit={(next) => {
              const language = next.trim().toLowerCase();
              if (/^(?:[a-z]{2,3})?$/.test(language))
                updateSettings({ voiceInput: { ...settings.voiceInput, language } });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
