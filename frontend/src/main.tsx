import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
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
import "./maintenance/observe"

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Root element #root was not found.")
}

createRoot(rootElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </MotionConfig>
  </StrictMode>,
)
