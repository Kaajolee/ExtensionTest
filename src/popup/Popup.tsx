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
  // The old useState(3) / useState(7) / "02:34:15" caused the popup to
  // flash bogus figures for the first render before real state replaced
  // them, which the audit flagged as the popup being "disconnected from
  // extension logic" because to a casual viewer it looked like the numbers
  // were hardcoded.
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

  useEffect(() => {
    // Send settings changes to service worker
    chrome.runtime.sendMessage({
      type: 'SETTINGS_CHANGED',
      settings: {
        breachThreshold: parseInt(breachThreshold) || 60,
        warningThreshold: parseInt(warningThreshold) || 20,
        isMuted,
        volume: volume[0],
        soundType,
        isDarkMode,
        breachColor,
        warningColor,
        refreshFrequency: parseInt(refreshFrequency) || 30,
      },
    }).catch(() => {})
  }, [breachThreshold, warningThreshold, isMuted, volume, soundType, isDarkMode, breachColor, warningColor, refreshFrequency])

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

  const handleWarningThresholdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Warning Threshold input activated', { value: e.target.value })
    setWarningThreshold(e.target.value)
    console.log('[Popup] Warning Threshold core logic: state updated to', e.target.value)
  }

  const handleRefreshFrequencyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log('[Popup] Refresh Frequency input activated', { value: e.target.value })
    setRefreshFrequency(e.target.value)
    console.log('[Popup] Refresh Frequency core logic: state updated to', e.target.value)
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
                        type="number"
                        value={breachThreshold}
                        onChange={handleBreachThresholdChange}
                        className="flex-1 h-9 text-center text-sm border-0 bg-muted/50"
                        min="1"
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
                        type="number"
                        value={warningThreshold}
                        onChange={handleWarningThresholdChange}
                        className="flex-1 h-9 text-center text-sm border-0 bg-muted/50"
                        min="1"
                      />
                      <span className="text-xs text-muted-foreground">sec</span>
                    </div>
                  </div>
                </div>
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
                      type="number"
                      value={refreshFrequency}
                      onChange={handleRefreshFrequencyChange}
                      className="w-16 h-9 text-center text-sm border-0 bg-muted/50"
                      min="5"
                      max="300"
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

                  {/* Volume Slider */}
                  <div
                    className={`space-y-3 transition-opacity ${isMuted ? "opacity-40 pointer-events-none" : ""}`}
                  >
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
                  <div
                    className={`space-y-2 transition-opacity ${isMuted ? "opacity-40 pointer-events-none" : ""}`}
                  >
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

              {/* Footer padding */}
              <div className="h-2" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
