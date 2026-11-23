import { subjectLabel } from "./subjects"
import { useSubjects } from "./useSubjects"

/** "Math › Algebra 1" under an item's title. Nothing when there is no subject (or it isn't known). */
export function SubjectLine({
  subject,
  subtopic,
  className = "subject-line",
}: {
  subject: string | null | undefined
  subtopic: string | null | undefined
  className?: string
}) {
  const { list } = useSubjects()
  const label = subjectLabel(list, subject, subtopic)
  if (!subject || !label) return null
  return (
    <p className={className}>
      <span className="sr-only">Subject: </span>
      {label}
    </p>
  )
}
