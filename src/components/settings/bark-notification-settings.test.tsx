import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  call: vi.fn(),
  desktop: false,
  remoteId: null as number | null,
  baseUrl: "https://codeg.example.com",
  status: vi.fn(),
  connection: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => backend,
  getActiveRemoteConnectionId: () => backend.remoteId,
  getServerBaseUrl: () => backend.baseUrl,
  isDesktop: () => backend.desktop,
}))
vi.mock("@/lib/api", () => ({ getWebServerStatus: backend.status }))
vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: backend.connection,
}))

import enMessages from "@/i18n/messages/en.json"
import {
  listBarkNotificationSettings,
  SHARED_BARK_DEVICE_ID,
  type BarkNotificationSettings,
} from "@/lib/bark-notifications"
import { BarkNotificationSettingsSection } from "./bark-notification-settings"

const phoneId = "12345678-1234-4234-8234-123456789abc"
const defaults: BarkNotificationSettings = {
  enabled: false,
  pushUrl: "",
  includePreview: false,
  language: "en",
  serverUrl: "",
  sourceName: "",
}
const phone: BarkNotificationSettings = {
  enabled: true,
  pushUrl: "https://bark.example.com/phone-secret",
  includePreview: true,
  language: "zh-Hans",
  serverUrl: "",
  sourceName: "Phone source",
}
type LegacySettings = Omit<BarkNotificationSettings, "sourceName"> & {
  sourceName?: string
}
let stored: Map<string, LegacySettings>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function settings() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BarkNotificationSettingsSection />
    </NextIntlClientProvider>
  )
}

async function ready() {
  await waitFor(() =>
    expect(screen.getByLabelText("Bark push URL")).toBeEnabled()
  )
}

async function selectSubscription(label: string) {
  fireEvent.keyDown(screen.getByLabelText("Subscription"), { key: "Enter" })
  const option = await screen.findByRole("option", { name: label })
  await act(async () => fireEvent.click(option))
}

const saveButton = () => screen.getByRole("button", { name: "Save" })
const testButton = () =>
  screen.getByRole("button", { name: "Test notification" })

describe("Bark notification settings", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    backend.desktop = false
    backend.remoteId = null
    backend.baseUrl = "https://codeg.example.com"
    backend.status.mockResolvedValue(null)
    backend.connection.mockResolvedValue({ name: "Academic server" })
    stored = new Map([[phoneId, { ...phone }]])
    backend.call.mockImplementation(
      async (command: string, args: Record<string, unknown>) => {
        switch (command) {
          case "list_bark_notification_settings":
            return [...stored].map(([deviceId, config]) => ({
              deviceId,
              settings: config,
            }))
          case "get_bark_notification_settings":
            return { ...(stored.get(args.deviceId as string) ?? defaults) }
          case "set_bark_notification_settings": {
            const normalized = {
              ...(args.settings as BarkNotificationSettings),
              pushUrl: (
                args.settings as BarkNotificationSettings
              ).pushUrl.trim(),
            }
            stored.set(args.deviceId as string, normalized)
            return normalized
          }
          case "test_bark_notification":
            return null
          default:
            throw new Error(`Unexpected command: ${command}`)
        }
      }
    )
  })

  it("loads the shared subscription and selects an existing iOS profile without changing its fields", async () => {
    render(settings())
    await ready()
    expect(backend.call).toHaveBeenCalledWith(
      "list_bark_notification_settings",
      {}
    )
    expect(backend.call).toHaveBeenCalledWith(
      "get_bark_notification_settings",
      { deviceId: SHARED_BARK_DEVICE_ID }
    )
    expect(screen.getByLabelText("Subscription")).toHaveTextContent(
      "Shared server subscription"
    )
    expect(screen.getByLabelText("Enable Bark notifications")).not.toBeChecked()
    expect(
      screen.getByLabelText("Include final reply preview")
    ).not.toBeChecked()
    expect(screen.getByLabelText("Notification language")).toHaveTextContent(
      "English"
    )
    expect(screen.getByLabelText("Codeg server URL (optional)")).toHaveValue(
      backend.baseUrl
    )
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      "codeg.example.com"
    )
    expect(testButton()).toBeDisabled()

    await selectSubscription("Phone device 12345678")
    await ready()
    expect(screen.getByLabelText("Bark push URL")).toHaveValue(phone.pushUrl)
    expect(screen.getByLabelText("Bark push URL")).toHaveAttribute(
      "type",
      "password"
    )
    expect(screen.getByLabelText("Notification language")).toHaveTextContent(
      "简体中文"
    )
    expect(screen.getByLabelText("Codeg server URL (optional)")).toHaveValue("")
    expect(screen.getByLabelText("Include final reply preview")).toBeChecked()
    fireEvent.click(saveButton())
    await screen.findByText("Bark settings saved.")
    expect(backend.call).toHaveBeenCalledWith(
      "set_bark_notification_settings",
      { deviceId: phoneId, settings: phone }
    )
    fireEvent.click(testButton())
    await screen.findByText("Test notification sent.")
    expect(backend.call).toHaveBeenCalledWith("test_bark_notification", {
      deviceId: phoneId,
    })
  })

  it("saves all fields through the shared UUID and tests only the normalized saved configuration", async () => {
    render(settings())
    await ready()
    fireEvent.click(screen.getByLabelText("Enable Bark notifications"))
    fireEvent.change(screen.getByLabelText("Bark push URL"), {
      target: { value: " https://bark.example.com/shared-secret " },
    })
    fireEvent.click(screen.getByLabelText("Include final reply preview"))
    const sourceName = screen.getByLabelText("Notification source name")
    expect(sourceName).toHaveAttribute("maxlength", "80")
    fireEvent.change(sourceName, { target: { value: "Academic server" } })
    expect(testButton()).toBeDisabled()
    fireEvent.click(testButton())
    expect(backend.call).not.toHaveBeenCalledWith(
      "test_bark_notification",
      expect.anything()
    )
    fireEvent.click(saveButton())
    await screen.findByText("Bark settings saved.")
    expect(backend.call).toHaveBeenCalledWith(
      "set_bark_notification_settings",
      {
        deviceId: SHARED_BARK_DEVICE_ID,
        settings: {
          enabled: true,
          pushUrl: " https://bark.example.com/shared-secret ",
          includePreview: true,
          language: "en",
          serverUrl: backend.baseUrl,
          sourceName: "Academic server",
        },
      }
    )
    expect(screen.getByLabelText("Bark push URL")).toHaveValue(
      "https://bark.example.com/shared-secret"
    )
    fireEvent.click(testButton())
    await screen.findByText("Test notification sent.")
    expect(backend.call).toHaveBeenLastCalledWith("test_bark_notification", {
      deviceId: SHARED_BARK_DEVICE_ID,
    })
    fireEvent.change(screen.getByLabelText("Codeg server URL (optional)"), {
      target: { value: "" },
    })
    expect(testButton()).toBeDisabled()
    fireEvent.click(saveButton())
    await screen.findByText("Bark settings saved.")
    await selectSubscription("Phone device 12345678")
    await ready()
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      "Phone source"
    )
    fireEvent.change(screen.getByLabelText("Notification source name"), {
      target: { value: "Unsaved phone source" },
    })
    await selectSubscription("Shared server subscription (browser and desktop)")
    await ready()
    expect(screen.getByLabelText("Codeg server URL (optional)")).toHaveValue("")
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      "Academic server"
    )
    await selectSubscription("Phone device 12345678")
    await ready()
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      "Phone source"
    )
  })

  it("preserves the draft on save failure and never displays credentials from errors", async () => {
    render(settings())
    await ready()
    fireEvent.change(screen.getByLabelText("Bark push URL"), {
      target: { value: "my draft" },
    })
    backend.call.mockRejectedValueOnce(
      new Error("https://bark.example.com/leaked-secret")
    )
    fireEvent.click(saveButton())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your edits are still here"
    )
    expect(document.body).not.toHaveTextContent("leaked-secret")
    expect(screen.getByLabelText("Bark push URL")).toHaveValue("my draft")
    expect(saveButton()).toBeEnabled()
    expect(testButton()).toBeDisabled()
  })

  it("keeps the saved draft on test failure and allows retry with a safe error", async () => {
    stored.set(SHARED_BARK_DEVICE_ID, { ...phone })
    render(settings())
    await ready()
    backend.call.mockRejectedValueOnce(new Error(phone.pushUrl))
    fireEvent.click(testButton())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send the test notification"
    )
    expect(document.body).not.toHaveTextContent(phone.pushUrl)
    expect(screen.getByLabelText("Bark push URL")).toHaveValue(phone.pushUrl)
    expect(testButton()).toBeEnabled()
  })

  it("can disable automatic notifications and still test the saved subscription", async () => {
    stored.set(SHARED_BARK_DEVICE_ID, { ...phone })
    render(settings())
    await ready()
    fireEvent.click(screen.getByLabelText("Enable Bark notifications"))
    expect(testButton()).toBeDisabled()
    fireEvent.click(saveButton())
    await screen.findByText("Bark settings saved.")
    expect(backend.call).toHaveBeenLastCalledWith(
      "set_bark_notification_settings",
      {
        deviceId: SHARED_BARK_DEVICE_ID,
        settings: { ...phone, enabled: false },
      }
    )
    expect(testButton()).toBeEnabled()
    fireEvent.click(testButton())
    await screen.findByText("Test notification sent.")
    expect(backend.call).toHaveBeenLastCalledWith("test_bark_notification", {
      deviceId: SHARED_BARK_DEVICE_ID,
    })
  })

  it("blocks editing during a deferred load and after a settings load failure, then supports retry", async () => {
    const pending = deferred<BarkNotificationSettings>()
    backend.call.mockResolvedValueOnce([]).mockReturnValueOnce(pending.promise)
    render(settings())
    await screen.findByLabelText("Bark push URL")
    expect(screen.getByLabelText("Enable Bark notifications")).toBeDisabled()
    expect(saveButton()).toBeDisabled()
    expect(testButton()).toBeDisabled()
    await act(async () =>
      pending.reject(new Error("https://bark.example.com/leaked-secret"))
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "update the Codeg server or desktop app"
    )
    expect(saveButton()).toBeDisabled()
    expect(document.body).not.toHaveTextContent("leaked-secret")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await ready()
    expect(saveButton()).toBeEnabled()
    expect(backend.call).not.toHaveBeenCalledWith(
      "set_bark_notification_settings",
      expect.anything()
    )
  })

  it("blocks the form when an older backend cannot list registrations", async () => {
    backend.call.mockRejectedValueOnce(
      new Error("Unknown command with https://bark.example.com/secret")
    )
    render(settings())
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "update the Codeg server or desktop app"
    )
    expect(screen.getByLabelText("Subscription")).toBeDisabled()
    expect(
      screen.queryByRole("button", { name: "Save" })
    ).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(
      "https://bark.example.com/secret"
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await ready()
  })

  it("ignores a late settings load after selecting another subscription", async () => {
    const pending = deferred<BarkNotificationSettings>()
    backend.call
      .mockResolvedValueOnce([{ deviceId: phoneId, settings: phone }])
      .mockReturnValueOnce(pending.promise)
    render(settings())
    await screen.findByLabelText("Bark push URL")
    await selectSubscription("Phone device 12345678")
    await ready()
    await act(async () =>
      pending.resolve({
        ...defaults,
        pushUrl: "stale-shared",
        sourceName: "Stale source",
      })
    )
    expect(screen.getByLabelText("Bark push URL")).toHaveValue(phone.pushUrl)
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      phone.sourceName
    )
    expect(screen.getByLabelText("Subscription")).toHaveTextContent(
      "Phone device 12345678"
    )
  })

  it.each(["save", "test"] as const)(
    "ignores a late %s response after subscription selection",
    async (action) => {
      stored.set(SHARED_BARK_DEVICE_ID, { ...phone })
      render(settings())
      await ready()
      const pending = deferred<BarkNotificationSettings | null>()
      backend.call.mockReturnValueOnce(pending.promise)
      fireEvent.click(action === "save" ? saveButton() : testButton())
      expect(screen.getByLabelText("Bark push URL")).toBeDisabled()
      await selectSubscription("Phone device 12345678")
      await ready()
      await act(async () =>
        pending.resolve(
          action === "save" ? { ...defaults, pushUrl: "stale-saved" } : null
        )
      )
      expect(screen.getByLabelText("Bark push URL")).toHaveValue(phone.pushUrl)
      expect(screen.queryByText("Bark settings saved.")).not.toBeInTheDocument()
      expect(
        screen.queryByText("Test notification sent.")
      ).not.toBeInTheDocument()
      expect(testButton()).toBeEnabled()
    }
  )

  it("resets subscriptions on workspace changes and ignores the previous workspace list", async () => {
    const pending = deferred<unknown[]>()
    backend.call.mockReturnValueOnce(pending.promise)
    const view = render(settings())
    backend.desktop = true
    backend.remoteId = 7
    backend.baseUrl = "https://remote.example.com/codeg"
    stored.clear()
    view.rerender(settings())
    await ready()
    expect(screen.getByLabelText("Codeg server URL (optional)")).toHaveValue(
      backend.baseUrl
    )
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      "Academic server"
    )
    expect(backend.connection).toHaveBeenCalledWith(7)
    await act(async () =>
      pending.resolve([{ deviceId: phoneId, settings: phone }])
    )
    fireEvent.keyDown(screen.getByLabelText("Subscription"), { key: "Enter" })
    expect(
      screen.queryByRole("option", { name: "Phone device 12345678" })
    ).not.toBeInTheDocument()
    expect(backend.status).not.toHaveBeenCalled()
  })

  it.each([
    {
      addresses: ["http://127.0.0.1:3000", "http://192.168.1.2:3000"],
      expected: "http://192.168.1.2:3000",
    },
    { addresses: ["http://127.0.0.1:3000", "http://[::1]:3000"], expected: "" },
    { addresses: [], expected: "" },
  ])(
    "uses a reachable desktop server address when available: $expected",
    async ({ addresses, expected }) => {
      backend.desktop = true
      backend.baseUrl = "http://tauri.localhost"
      backend.status.mockResolvedValue({
        port: 3000,
        token: "unused",
        addresses,
      })
      render(settings())
      await ready()
      expect(screen.getByLabelText("Codeg server URL (optional)")).toHaveValue(
        expected
      )
      expect(screen.getByLabelText("Notification source name")).toHaveValue(
        expected ? new URL(expected).hostname : ""
      )
    }
  )

  it("round-trips backend defaults and preserves an explicitly empty saved server URL", async () => {
    stored.set(SHARED_BARK_DEVICE_ID, { ...defaults })
    render(settings())
    await ready()
    expect(screen.getByLabelText("Codeg server URL (optional)")).toHaveValue("")
    expect(screen.getByLabelText("Notification source name")).toHaveValue("")
    fireEvent.click(saveButton())
    await screen.findByText("Bark settings saved.")
    expect(backend.call).toHaveBeenLastCalledWith(
      "set_bark_notification_settings",
      { deviceId: SHARED_BARK_DEVICE_ID, settings: defaults }
    )
  })

  it("preserves a saved source name instead of the current remote connection name", async () => {
    backend.desktop = true
    backend.remoteId = 7
    stored.set(SHARED_BARK_DEVICE_ID, { ...phone, sourceName: "Saved server" })
    render(settings())
    await ready()
    expect(screen.getByLabelText("Notification source name")).toHaveValue(
      "Saved server"
    )
    expect(testButton()).toBeEnabled()
  })

  it.each(["unavailable", "blank"])(
    "falls back to the URL hostname when the remote name is %s",
    async (name) => {
      backend.desktop = true
      backend.remoteId = 7
      backend.baseUrl = "https://remote.example.com:8443/codeg?token=unused"
      if (name === "unavailable") {
        backend.connection.mockRejectedValue(new Error("unavailable"))
      } else {
        backend.connection.mockResolvedValue({ name: "  " })
      }
      render(settings())
      await ready()
      expect(screen.getByLabelText("Notification source name")).toHaveValue(
        "remote.example.com"
      )
    }
  )

  it("normalizes missing source names from older list, load and save responses", async () => {
    const legacy: LegacySettings = { ...phone }
    delete legacy.sourceName
    stored.set(SHARED_BARK_DEVICE_ID, legacy)
    expect(await listBarkNotificationSettings()).toContainEqual({
      deviceId: SHARED_BARK_DEVICE_ID,
      settings: { ...legacy, sourceName: "" },
    })
    render(settings())
    await ready()
    expect(screen.getByLabelText("Notification source name")).toHaveValue("")
    expect(testButton()).toBeEnabled()
    fireEvent.change(screen.getByLabelText("Notification source name"), {
      target: { value: "Academic server" },
    })
    expect(testButton()).toBeDisabled()
    backend.call.mockResolvedValueOnce(legacy)
    fireEvent.click(saveButton())
    await screen.findByText("Bark settings saved.")
    expect(screen.getByLabelText("Notification source name")).toHaveValue("")
    expect(testButton()).toBeEnabled()
  })
})
