import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import { ComposerUploadProgress } from "./composer-upload-progress"

function renderChips(
  uploads: React.ComponentProps<typeof ComposerUploadProgress>["uploads"]
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerUploadProgress uploads={uploads} />
    </NextIntlClientProvider>
  )
}

describe("ComposerUploadProgress", () => {
  it("renders nothing without in-flight uploads", () => {
    const { container } = renderChips([])
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the file name and its byte percentage", () => {
    renderChips([
      { id: "u1", name: "report.pdf", size: 100, loaded: 42, total: 100 },
    ])
    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    expect(screen.getByText("42%")).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42"
    )
  })

  it("caps the in-flight percentage at 99 until the upload settles", () => {
    renderChips([
      { id: "u1", name: "video.mov", size: 100, loaded: 100, total: 100 },
    ])
    expect(screen.getByText("99%")).toBeInTheDocument()
  })

  it("falls back to an indeterminate state when the total is unknown", () => {
    renderChips([
      { id: "u1", name: "/tmp/photo.raw", size: 0, loaded: 0, total: null },
    ])
    expect(screen.getByText("Uploading")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })
})
