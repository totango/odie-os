import { createFileRoute } from '@tanstack/react-router'
import NewRequestPage from '../community-requests/NewRequestPage'

export const Route = createFileRoute('/requests_/new')({ component: NewRequestPage })
