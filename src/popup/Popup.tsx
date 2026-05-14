import { useState, useEffect } from "react"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Moon,
  Sun,
  RotateCcw,
  Activity,
  Clock,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  Volume2,
  VolumeX,
  Play,
} from "lucide-react"

export function Popup() {
  // Customization
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [breachColor, setBreachColor] = useState("#ef4444")
  const [warningColor, setWarningColor] = useState("#f59e0b")

  // Status
  const [isEnabled, setIsEnabled] = useState(true)
  // Audit finding #2 (CRITICAL): initial values must be the empty/zero
  // state, not mock numbers. Real values arrive from the service worker on
  // mount via REQUEST_CURRENT_STATE and on every STATE_UPDATE thereafter.
  const [breachedChats, setBreachedChats] = useState(0)
  const [warningChats, setWarningChats] = useState(0)
  const [runtime, setRuntime] = useState("00:00:00")

  // Chat Refresh
  const [refreshFrequency, setRefreshFrequency] = useState("30")

  // Threshold
  const [breachThreshold, setBreachThreshold] = useState("120")
  const [warningThreshold, setWarningThreshold] = useState("60")

  // Sound
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState([75])
  const [soundType, setSoundType] = useState("chime")

  useEffect(() => {
    // Request current state from service worker
    chrome.runtime.sendMessage({ type: 'REQUEST_CURRENT_STATE' }, (response) => {
      if (response?.metrics) {
        setBreachedChats(response.metrics.breachedCount)
        setWarningChats(response.metrics.warningCount)
      }
      if (response?.settings) {
        const s = response.settings
        setBreachThreshold(s.breachThreshold?.toString() || '60')
        setWarningThreshold(s.warningThreshold?.toString() || '20')
        setIsMuted(s.isMuted ?? false)
        setVolume([s.volume ?? 25])
        setSoundType(s.soundType ?? 'beep')
        setIsDarkMode(s.isDarkMode ?? false)
        setBreachColor(s.breachColor ?? '#ef4444')
        setWarningColor(s.warningColor ?? '#f59e0b')
        // Persistence: the master toggle and the chat-refresh frequency
        // also round-trip through the service worker now, so the popup
        // re-opens in exactly the state the user left it.
        setIsEnabled(s.isEnabled ?? true)
        setRefreshFrequency(s.refreshFrequency?.toString() || '30')
      }
    })

    // Listen for state updates from service worker
    const handleMessage = (request: any) => {
      if (request.type === 'STATE_UPDATE') {
        setBreachedChats(request.metrics.breachedCount)
        setWarningChats(request.metrics.warningCount)
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage)

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])

  // ---- Audit finding #8 (MEDIUM): UI-side validation -----------------------
  //
  // The newUI design treats the threshold + refresh fields as strict digit
  // strings (no negatives, no decimals, no e-notation), and surfaces three
  // visual states:
  //   - null    : neutral (during typing / empty)
  //   - valid   : no decoration
  //   - warning : amber ring + amber message ("equal values: only breach
  //               will count")
  //   - invalid : red ring + red message
  //
  // We still gate SETTINGS_CHANGED on a strict validity check so the service
  // worker never receives mid-edit garbage. Equal values are allowed
  // (warning) and ARE saved, matching the newUI behavior.

  const isValidNumber = (value: string): boolean => {
    if (value === "") return true // allow empty while typing
    if (!/^\d+$/.test(value)) return false
    const n = Number(value)
    return Number.isFinite(n) && n >= 0
  }

  type ValState = "valid" | "invalid" | "warning" | null

  const getInputValidationState = (value: string): ValState => {
    if (value === "") return null
    if (!isValidNumber(value)) return "invalid"
    return "valid"
  }

  const getThresholdValidationState = (): {
    breach: ValState
    warning: ValState
    message: string | null
  } => {
    const breachValid = isValidNumber(breachThreshold)
    const warningValid = isValidNumber(warningThreshold)

    if (!breachValid)
      return { breach: "invalid", warning: getInputValidationState(warningThreshold), message: "Invalid breach value" }
    if (!warningValid)
      return { breach: getInputValidationState(breachThreshold), warning: "invalid", message: "Invalid warning value" }

    if (breachThreshold === "" || warningThreshold === "")
      return { breach: null, warning: null, message: null }

    const breachNum = Number(breachThreshold)
    const warningNum = Number(warningThreshold)

    if (breachNum === 0 && warningNum === 0)
      return { breach: "invalid", warning: "invalid", message: "Values cannot be 0" }
    if (breachNum === 0)
      return { breach: "invalid", warning: getInputValidationState(warningThreshold), message: "Breach cannot be 0" }
    if (warningNum === 0)
      return { breach: getInputValidationState(breachThreshold), warning: "invalid", message: "Warning cannot be 0" }

    if (breachNum < warningNum)
      return { breach: "invalid", warning: "invalid", message: "Breach cannot be less than the warning" }

    if (breachNum === warningNum)
      return { breach: "warning", warning: "warning", message: "Equal values: only the breach will count" }

    return { breach: "valid", warning: "valid", message: null }
  }

  const getRefreshValidationState = (): "valid" | "invalid" | null => {
    if (refreshFrequency === "") return null
    if (!isValidNumber(refreshFrequency)) return "invalid"
    if (Number(refreshFrequency) === 0) return "invalid"
    return "valid"
  }

  const thresholdState = getThresholdValidationState()
  const refreshState = getRefreshValidationState()

  // SETTINGS_CHANGED is only suppressed for hard-invalid states (red). Amber
  // "warning" (equal values) is still a saveable config.
  const thresholdsSendable =
    thresholdState.breach !== "invalid" &&
    thresholdState.warning !== "invalid" &&
    breachThreshold !== "" &&
    warningThreshold !== ""

  const getInputClassName = (state: ValState, baseClass: string): string => {
    if (state === "invalid")
      return `${baseClass} ring-2 ring-red-500 focus-visible:ring-red-500`
    if (state === "warning")
      return `${baseClass} ring-2 ring-amber-500 focus-visible:ring-amber-500`
    return baseClass
  }

  useEffect(() => {
    // Send settings changes to service worker - but only if numeric
    // thresholds are valid. Otherwise the popup is showing an in-progress
    // edit (e.g. the user just cleared the field to retype) and we'd be
    // sending the SW garbage that its sanitizer would just clamp anyway.
    if (!thresholdsSendable) {
      console.log('[Popup] SETTINGS_CHANGED suppressed - invalid thresholds', {
        breachThreshold, warningThreshold,
      })
      return
    }
    chrome.runtime.sendMessage({
      type: 'SETTINGS_CHANGED',
      settings: {
        breachThreshold: parseInt(breachThreshold, 10),
        warningThreshold: parseInt(warningThreshold, 10),
        isMuted,
        volume: volume[0],
        soundType,
        isDarkMode,
        breachColor,
        warningColor,
        refreshFrequency: parseInt(refreshFrequency, 10) || 30,
        // isEnabled is the master on/off toggle; round-tripping it through
        // the SW makes the popup re-open in the same state.
        isEnabled,
      },
    }).catch(() => {})
  }, [breachThreshold, warningThreshold, isMuted, volume, soundType, isDarkMode, breachColor, warningColor, refreshFrequency, isEnabled, thresholdsSendable])

  const handleReset = () => {
    console.log('[Popup] Reset button activated')
    setBreachedChats(0)
    setWarningChats(0)
    setRuntime("00:00:00")
    console.log('[Popup] Reset core logic: sending RESET message to service worker')
    chrome.runtime.sendMessage({ type: 'RESET' }).catch(() => {})
  }

  const handlePlaySound = () => {
    console.log('[Popup] Play Sound button activated')
    console.log('[Popup] Play Sound core logic: sending PLAY_SOUND message', { soundType, volume: volume[0] })
    chrome.runtime.sendMessage({
      type: 'PLAY_SOUND',
      soundType,
      volume: volume[0],
    }).catch(() => {})
  }

  const handleEnabledChange = (checked: boolean) => {
    console.log('[Popup] Enabled switch activated', { checked })
    setIsEnabled(checked)
    console.log('[Popup] Enabled core logic: state updated to', checked)
  }

  const handleBreachThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Breach Threshold input activated', { value: e.target.value })
    setBreachThreshold(e.target.value)
    console.log('[Popup] Breach Threshold core logic: state updated to', e.target.value)
  }

  const handleBreachThresholdBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.target.value === "" || e.target.value === "0") {
      console.log('[Popup] Breach Threshold blur snap to "2"')
      setBreachThreshold("2")
    }
  }

  const handleWarningThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Warning Threshold input activated', { value: e.target.value })
    setWarningThreshold(e.target.value)
    console.log('[Popup] Warning Threshold core logic: state updated to', e.target.value)
  }

  const handleWarningThresholdBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.target.value === "" || e.target.value === "0") {
      console.log('[Popup] Warning Threshold blur snap to "1"')
      setWarningThreshold("1")
    }
  }

  const handleRefreshFrequencyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Refresh Frequency input activated', { value: e.target.value })
    setRefreshFrequency(e.target.value)
    console.log('[Popup] Refresh Frequency core logic: state updated to', e.target.value)
  }

  const handleRefreshFrequencyBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.target.value === "" || e.target.value === "0") {
      console.log('[Popup] Refresh Frequency blur snap to "1"')
      setRefreshFrequency("1")
    }
  }

  const handleMuteChange = (checked: boolean) => {
    console.log('[Popup] Mute switch activated', { checked })
    setIsMuted(checked)
    console.log('[Popup] Mute core logic: state updated to', checked)
  }

  const handleVolumeChange = (newVolume: number[]) => {
    console.log('[Popup] Volume slider activated', { volume: newVolume[0] })
    setVolume(newVolume)
    console.log('[Popup] Volume core logic: state updated to', newVolume[0])
  }

  const handleSoundTypeChange = (value: string) => {
    console.log('[Popup] Sound Type select activated', { value })
    setSoundType(value)
    console.log('[Popup] Sound Type core logic: state updated to', value)
  }

  const handleDarkModeChange = (checked: boolean) => {
    console.log('[Popup] Dark Mode switch activated', { checked })
    setIsDarkMode(checked)
    console.log('[Popup] Dark Mode core logic: state updated to', checked)
  }

  const handleBreachColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Breach Color picker activated', { value: e.target.value })
    setBreachColor(e.target.value)
    console.log('[Popup] Breach Color core logic: state updated to', e.target.value)
  }

  const handleWarningColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Warning Color picker activated', { value: e.target.value })
    setWarningColor(e.target.value)
    console.log('[Popup] Warning Color core logic: state updated to', e.target.value)
  }

  return (
    <div
      className={`min-h-screen transition-colors duration-200 ${isDarkMode ? "dark" : ""}`}
    >
      <div className="bg-background text-foreground min-h-screen">
        <div className="w-[360px] mx-auto">
          {/* Scrollable Content */}
          <div className="max-h-[540px] overflow-y-auto">
            {/* Header */}
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-3">
              <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">Chat Monitor</h1>
                <div className="flex items-center gap-2">
                  <Activity
                    className={`h-4 w-4 ${isEnabled ? "text-emerald-500" : "text-muted-foreground"}`}
                  />
                  <span
                    className={`text-xs font-medium ${isEnabled ? "text-emerald-500" : "text-muted-foreground"}`}
                  >
                    {isEnabled ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Section: Status (Hero Section) */}
              <section className="rounded-xl border border-border bg-card p-6">
                {/* H1: Breached Count - Primary Focus */}
                <div className="text-center mb-6">
                  <div className="flex items-center justify-center gap-3 mb-2">
                    <AlertCircle className="h-8 w-8 text-red-500" />
                    <span className="text-6xl font-bold tabular-nums text-red-500">
                      {breachedChats}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Breached
                  </p>
                </div>

                {/* H2: Warning Count - Secondary */}
                <div className="text-center mb-6 pb-6 border-b border-border">
                  <div className="flex items-center justify-center gap-2 mb-1">
                    <AlertTriangle className="h-5 w-5 text-amber-500" />
                    <span className="text-3xl font-semibold tabular-nums text-amber-500">
                      {warningChats}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Warning Zone
                  </p>
                </div>

                {/* H3: Runtime + Controls - Tertiary */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-mono tabular-nums text-muted-foreground">
                      {runtime}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleReset}
                      className="h-8 px-3 text-xs"
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                      Reset
                    </Button>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs font-medium ${isEnabled ? "text-emerald-500" : "text-muted-foreground"}`}
                      >
                        {isEnabled ? "On" : "Off"}
                      </span>
                      <Switch checked={isEnabled} onCheckedChange={handleEnabledChange} />
                    </div>
                  </div>
                </div>
              </section>

              {/* The rest of the settings - blurred and disabled when not enabled */}
              <div
                className={`space-y-4 transition-all duration-300 ${
                  !isEnabled ? "opacity-50 pointer-events-none select-none" : ""
                }`}
                style={
                  !isEnabled
                    ? { filter: 'blur(4px)', transform: 'translateZ(0)' }
                    : undefined
                }
                aria-hidden={!isEnabled}
              >
                {/* Section: Threshold */}
                <section className="rounded-xl border border-border bg-card p-4">
                  <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
                    Threshold
                  </h2>
                  <div className="grid grid-cols-2 gap-6">
                    {/* Breach Threshold */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-red-500" />
                        <Label className="text-sm font-medium">Breach</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={breachThreshold}
                          onChange={handleBreachThresholdChange}
                          onBlur={handleBreachThresholdBlur}
                          aria-invalid={thresholdState.breach === "invalid"}
                          className={getInputClassName(
                            thresholdState.breach,
                            "flex-1 h-9 text-center text-sm border-0 bg-muted/50",
                          )}
                        />
                        <span className="text-xs text-muted-foreground">sec</span>
                      </div>
                    </div>
                    {/* Warning Threshold */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                        <Label className="text-sm font-medium">Warning</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="text"
                          inputMode="numeric"
                          value={warningThreshold}
                          onChange={handleWarningThresholdChange}
                          onBlur={handleWarningThresholdBlur}
                          aria-invalid={thresholdState.warning === "invalid"}
                          className={getInputClassName(
                            thresholdState.warning,
                            "flex-1 h-9 text-center text-sm border-0 bg-muted/50",
                          )}
                        />
                        <span className="text-xs text-muted-foreground">sec</span>
                      </div>
                    </div>
                  </div>
                  {/* Validation Message */}
                  {thresholdState.message && (
                    <p
                      role="alert"
                      className={`text-xs mt-3 ${
                        thresholdState.breach === "warning"
                          ? "text-amber-500"
                          : "text-red-500"
                      }`}
                    >
                      {thresholdState.message}
                    </p>
                  )}
                </section>

                {/* Section: Chat Refresh */}
                <section className="rounded-xl border border-border bg-card p-4">
                  <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
                    Chat Refresh
                  </h2>
                  <div className="flex items-center gap-3">
                    <RefreshCw className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1">
                      <Label className="text-sm font-medium">
                        Refresh Frequency
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        How often to refresh the chat window
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="text"
                        inputMode="numeric"
                        value={refreshFrequency}
                        onChange={handleRefreshFrequencyChange}
                        onBlur={handleRefreshFrequencyBlur}
                        aria-invalid={refreshState === "invalid"}
                        className={getInputClassName(
                          refreshState,
                          "w-16 h-9 text-center text-sm border-0 bg-muted/50",
                        )}
                      />
                      <span className="text-xs text-muted-foreground">sec</span>
                    </div>
                  </div>
                </section>

                {/* Section: Sound */}
                <section className="rounded-xl border border-border bg-card p-4">
                  <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
                    Sound
                  </h2>
                  <div className="space-y-5">
                    {/* Mute Toggle */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isMuted ? (
                          <VolumeX className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Volume2 className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div>
                          <Label className="text-sm font-medium">Mute Sound</Label>
                          <p className="text-xs text-muted-foreground">
                            Disable audio
                          </p>
                        </div>
                      </div>
                      <Switch checked={isMuted} onCheckedChange={handleMuteChange} />
                    </div>

                    {/* Sound controls - blur when muted */}
                    <div
                      className={`space-y-5 transition-all duration-300 ${
                        isMuted ? "blur-sm opacity-50 pointer-events-none" : ""
                      }`}
                    >
                      {/* Volume Slider */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm font-medium">Volume</Label>
                          <span className="text-sm font-mono tabular-nums text-muted-foreground">
                            {volume[0]}%
                          </span>
                        </div>
                        <Slider
                          value={volume}
                          onValueChange={handleVolumeChange}
                          max={100}
                          step={1}
                          className="w-full"
                        />
                      </div>

                      {/* Sound Type */}
                      <div className="space-y-2">
                        <Label className="text-sm font-medium">Sound Type</Label>
                        <div className="flex items-center gap-2">
                          <Select value={soundType} onValueChange={handleSoundTypeChange}>
                            <SelectTrigger className="flex-1 h-9 border-0 bg-muted/50">
                              <SelectValue placeholder="Select sound" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="chime">Chime</SelectItem>
                              <SelectItem value="bell">Bell</SelectItem>
                              <SelectItem value="alert">Alert</SelectItem>
                              <SelectItem value="notification">Notification</SelectItem>
                              <SelectItem value="beep">Beep</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={handlePlaySound}
                            className="h-9 w-9 shrink-0"
                            disabled={isMuted}
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Section: Customization */}
                <section className="rounded-xl border border-border bg-card p-4">
                  <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
                    Customization
                  </h2>
                  <div className="space-y-5">
                    {/* Dark Mode Toggle */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isDarkMode ? (
                          <Moon className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Sun className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div>
                          <Label className="text-sm font-medium">
                            {isDarkMode ? "Dark Mode" : "Light Mode"}
                          </Label>
                          <p className="text-xs text-muted-foreground">
                            Toggle appearance theme
                          </p>
                        </div>
                      </div>
                      <Switch checked={isDarkMode} onCheckedChange={handleDarkModeChange} />
                    </div>

                    {/* Chat Row Visual Alerts */}
                    <div className="space-y-3">
                      <Label className="text-sm font-medium">
                        Chat Row Visuals
                      </Label>
                      <div className="grid grid-cols-2 gap-4">
                        {/* Breached Color */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                            <span className="text-xs font-medium">Breached</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={breachColor}
                              onChange={handleBreachColorChange}
                              className="h-9 w-9 rounded-lg cursor-pointer bg-transparent border-0"
                            />
                            <div
                              className="h-9 flex-1 rounded-lg"
                              style={{ backgroundColor: breachColor }}
                            />
                          </div>
                        </div>
                        {/* Warning Color */}
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                            <span className="text-xs font-medium">Warning</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={warningColor}
                              onChange={handleWarningColorChange}
                              className="h-9 w-9 rounded-lg cursor-pointer bg-transparent border-0"
                            />
                            <div
                              className="h-9 flex-1 rounded-lg"
                              style={{ backgroundColor: warningColor }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>

              {/* Footer padding */}
              <div className="h-2" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
