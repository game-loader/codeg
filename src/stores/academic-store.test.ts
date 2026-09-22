import { beforeEach, describe, expect, it, vi } from "vitest"
import { useAcademicStore } from "./academic-store"
import {
  academicLibrary,
  academicPaperGet,
  academicSelect,
} from "@/lib/academic"
import type { AcademicLibrary, AcademicPaper } from "@/lib/academic"

vi.mock("@/lib/academic", () => ({
  academicLibrary: vi.fn(),
  academicPaperGet: vi.fn(),
  academicSelect: vi.fn(),
  academicSettingsGet: vi.fn(),
}))

const paper = (id: string) =>
  ({ id, title: id, status: "ready" }) as AcademicPaper

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(academicPaperGet).mockImplementation(async (id) => paper(id))
  useAcademicStore.getState().reset()
})

describe("academic selection", () => {
  it("recovers a terminal preparation event that arrived before selection resolved", async () => {
    vi.mocked(academicSelect).mockResolvedValue({
      ...paper("fast"),
      status: "queued",
    })
    vi.mocked(academicPaperGet).mockResolvedValue({
      ...paper("fast"),
      status: "no_code",
    })
    await useAcademicStore.getState().selectItem("fast")
    expect(useAcademicStore.getState().selectedPaper?.status).toBe("no_code")
    expect(academicPaperGet).toHaveBeenCalledTimes(1)
  })

  it("does not let an earlier paper response replace the latest selection", async () => {
    let finishFirst!: (value: AcademicPaper) => void
    vi.mocked(academicSelect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        })
    )
    vi.mocked(academicSelect).mockResolvedValueOnce(paper("second"))
    const first = useAcademicStore.getState().selectItem("first")
    await useAcademicStore.getState().selectItem("second")
    finishFirst(paper("first"))
    await first
    expect(useAcademicStore.getState().selectedPaper?.id).toBe("second")
  })

  it("keeps a paper opened from conversation context when an older selection resolves", async () => {
    let finish!: (value: AcademicPaper) => void
    vi.mocked(academicSelect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = useAcademicStore.getState().selectItem("first")
    useAcademicStore.getState().showPaper(paper("context-paper"))
    finish(paper("first"))
    await pending
    expect(useAcademicStore.getState().selectedPaper?.id).toBe("context-paper")
    expect(useAcademicStore.getState().loadingPaper).toBe(false)
  })

  it("does not restore a selection after the backend store was reset", async () => {
    let finish!: (value: AcademicPaper) => void
    vi.mocked(academicSelect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = useAcademicStore.getState().selectItem("first")
    useAcademicStore.getState().reset()
    finish(paper("first"))
    await pending
    expect(useAcademicStore.getState().selectedPaper).toBeNull()
  })

  it("only reloads the selected paper for a backend event", async () => {
    useAcademicStore.setState({ selectedPaper: paper("selected") })
    await useAcademicStore.getState().refreshPaper("unrelated")
    expect(academicPaperGet).not.toHaveBeenCalled()
    vi.mocked(academicPaperGet).mockResolvedValue(paper("selected"))
    await useAcademicStore.getState().refreshPaper("selected")
    expect(academicPaperGet).toHaveBeenCalledWith("selected")
  })

  it("retains the previous library on refresh failure and exposes the error", async () => {
    const library = {
      items: [],
      collections: [],
      library_id: 1,
      instance_id: "local",
    } satisfies AcademicLibrary
    useAcademicStore.setState({ library })
    vi.mocked(academicLibrary).mockRejectedValue(
      new Error("Zotero is not running")
    )
    await useAcademicStore.getState().refreshLibrary()
    expect(useAcademicStore.getState().library).toBe(library)
    expect(useAcademicStore.getState().error).toBe("Zotero is not running")
    expect(useAcademicStore.getState().loadingLibrary).toBe(false)
  })
})

it("reconciles paper progress even when the Zotero library is unavailable on reconnect", async () => {
  useAcademicStore.setState({
    selectedPaper: { ...paper("selected"), status: "cloning" },
  })
  vi.mocked(academicLibrary).mockRejectedValue(new Error("Zotero offline"))
  await useAcademicStore.getState().refreshLibrary()
  expect(useAcademicStore.getState().selectedPaper?.status).toBe("ready")
  expect(useAcademicStore.getState().error).toBe("Zotero offline")
})
