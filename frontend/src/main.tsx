import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider, createBrowserRouter } from "react-router-dom"
import { MotionConfig } from "motion/react"

import App from "./App"
import { AuthProvider } from "./AuthContext"
import "@fontsource-variable/fraunces"
import "@fontsource-variable/bricolage-grotesque"
import "@fontsource/gochi-hand"
import "./styles.css"
import "./capture/capture.css"
import "./notes/notes.css"
import "./study/study.css"

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Root element #root was not found.")
}

// A data router, so an open editor can hold an in-app link until its work is saved (useBlocker).
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <AuthProvider>
        <App />
      </AuthProvider>
    ),
  },
])

createRoot(rootElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <RouterProvider router={router} />
    </MotionConfig>
  </StrictMode>,
)
