import { describe, expect, it } from "vitest"

import { currentRemoteConnectionId, decideBackendSwitch } from "./window-state"

describe("decideBackendSwitch", () => {
  it("stays when the window is already on the workspace's backend", () => {
    expect(
      decideBackendSwitch({ current: null, wanted: null, hasContent: false })
    ).toBe("stay")
    expect(
      decideBackendSwitch({ current: 3, wanted: 3, hasContent: true })
    ).toBe("stay")
  })

  it("moves an empty window right away", () => {
    expect(
      decideBackendSwitch({ current: null, wanted: 3, hasContent: false })
    ).toBe("navigate")
    expect(
      decideBackendSwitch({ current: 3, wanted: null, hasContent: false })
    ).toBe("navigate")
  })

  it("waits for New question while a question is open", () => {
    expect(
      decideBackendSwitch({ current: null, wanted: 3, hasContent: true })
    ).toBe("defer")
  })
})

describe("currentRemoteConnectionId", () => {
  it("reads the page's remote binding", () => {
    expect(currentRemoteConnectionId("")).toBeNull()
    expect(
      currentRemoteConnectionId("?remoteConnectionId=4&remoteWindowId=rw-1")
    ).toBe(4)
    expect(currentRemoteConnectionId("?remoteConnectionId=x")).toBeNull()
  })
})
