"use client"

import { useEffect } from "react"

import { installGlobalErrorReporting } from "@/lib/client-error-report"

/**
 * Forwards this window's uncaught errors and unhandled promise rejections to
 * the backend's log. Mounted once, at the root layout.
 */
export function ClientErrorReporting() {
  useEffect(() => installGlobalErrorReporting(), [])
  return null
}
