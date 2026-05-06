import { useState } from "react"
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
  const [breachedChats, setBreachedChats] = useState(3)
  const [warningChats, setWarningChats] = useState(7)
  const [runtime, setRuntime] = useState("02:34:15")

  // Chat Refresh
  const [refreshFrequency, setRefreshFrequency] = useState("30")

  // Threshold
  const [breachThreshold, setBreachThreshold] = useState("120")
  const [warningThreshold, setWarningThreshold] = useState("60")

  // Sound
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState([75])
  const [soundType, setSoundType] = useState("chime")

  const handleReset = () => {
    setBreachedChats(0)
    setWarningChats(0)
    setRuntime("00:00:00")
  }

  const handlePlaySound = () => {
    console.log("Playing sound:", soundType)
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
                      <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
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
                        onChange={(e) => setBreachThreshold(e.target.value)}
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
                        onChange={(e) => setWarningThreshold(e.target.value)}
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
                      onChange={(e) => setRefreshFrequency(e.target.value)}
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
                    <Switch checked={isMuted} onCheckedChange={setIsMuted} />
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
                      onValueChange={setVolume}
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
                      <Select value={soundType} onValueChange={setSoundType}>
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
                    <Switch checked={isDarkMode} onCheckedChange={setIsDarkMode} />
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
                            onChange={(e) => setBreachColor(e.target.value)}
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
                            onChange={(e) => setWarningColor(e.target.value)}
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
