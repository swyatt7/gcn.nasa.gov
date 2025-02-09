/*!
 * Copyright © 2023 United States Government as represented by the
 * Administrator of the National Aeronautics and Space Administration.
 * All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import { tables } from '@architect/functions'
import type { DynamoDB } from '@aws-sdk/client-dynamodb'
import { type DynamoDBDocument, paginateScan } from '@aws-sdk/lib-dynamodb'
import { search as getSearch } from '@nasa-gcn/architect-functions-search'
import {
  DynamoDBAutoIncrement,
  DynamoDBHistoryAutoIncrement,
} from '@nasa-gcn/dynamodb-autoincrement'
import { redirect } from '@remix-run/node'
import memoizee from 'memoizee'

import { type User, getUser } from '../_gcn._auth/user.server'
import {
  bodyIsValid,
  formatAuthor,
  formatIsValid,
  parseEventFromSubject,
  subjectIsValid,
} from './circulars.lib'
import type {
  Circular,
  CircularChangeRequest,
  CircularMetadata,
} from './circulars.lib'

// A type with certain keys required.
type Require<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

export const group = 'gcn.nasa.gov/circular-submitter'
export const moderatorGroup = 'gcn.nasa.gov/circular-moderator'

const getDynamoDBAutoIncrement = memoizee(
  async function () {
    const db = await tables()
    const doc = db._doc as unknown as DynamoDBDocument

    const tableName = db.name('circulars')
    const counterTableName = db.name('auto_increment_metadata')
    const dangerously =
      (await (db._db as unknown as DynamoDB).config.endpoint?.())?.hostname ==
      'localhost'

    return new DynamoDBAutoIncrement({
      doc,
      counterTableName,
      counterTableKey: { tableName: 'circulars' },
      tableName,
      attributeName: 'circularId',
      initialValue: 1,
      dangerously,
    })
  },
  { promise: true }
)

async function getDynamoDBVersionAutoIncrement(circularId: number) {
  const db = await tables()
  const doc = db._doc as unknown as DynamoDBDocument
  const counterTableName = db.name('circulars')
  const tableName = db.name('circulars_history')
  const dangerously =
    (await (db._db as unknown as DynamoDB).config.endpoint?.())?.hostname ==
    'localhost'

  return new DynamoDBHistoryAutoIncrement({
    doc,
    counterTableName,
    counterTableKey: { circularId },
    attributeName: 'version',
    tableName,
    initialValue: 1,
    dangerously,
  })
}

/** convert a date in format mm-dd-yyyy (or YYYY-MM_DD) to ms since 01/01/1970 */
function parseDate(date?: string) {
  return date ? new Date(date).getTime() : NaN
}

/** take input string and return start/end times based on string value */
function fuzzyTimeRange(fuzzyTime?: string) {
  const now = Date.now()
  switch (fuzzyTime) {
    case 'now': // current time
      return now
    case 'hour': // 1 hour ago
      return now - 3600000
    case 'today': // 00:00:00 of same day
      return new Date().setHours(0, 0, 0, 0)
    case 'day': // 24 hours ago
      return now - 86400000
    case 'week': // 7 days ago
      return now - 86400000 * 7
    case 'month': // 30 days ago
      return now - 86400000 * 30
    case 'year': // 365 days ago
      return now - 86400000 * 365
    case 'mtd': // month to date
      return new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        1
      ).getTime()
    case 'ytd': // year to date
      return new Date(new Date().getFullYear(), 0).getTime()
    default:
      return NaN
  }
}

function getValidDates(startDate?: string, endDate?: string) {
  const startTimestamp = fuzzyTimeRange(startDate) || parseDate(startDate)
  const endTimestamp = fuzzyTimeRange(endDate) || parseDate(endDate) + 86400000
  return [startTimestamp, endTimestamp]
}

export async function search({
  query,
  page,
  limit,
  startDate,
  endDate,
  sort,
}: {
  query?: string
  page?: number
  limit?: number
  startDate?: string
  endDate?: string
  sort?: string
}): Promise<{
  items: CircularMetadata[]
  totalPages: number
  totalItems: number
}> {
  const client = await getSearch()

  const [startTime, endTime] = getValidDates(startDate, endDate)

  const sortObj =
    sort === 'relevance' && query
      ? {}
      : {
          circularId: {
            order: 'desc',
          },
        }

  const {
    body: {
      hits: {
        total: { value: totalItems },
        hits,
      },
    },
  } = await client.search({
    index: 'circulars',
    body: {
      query: {
        bool: {
          must: query
            ? {
                multi_match: {
                  query,
                  fields: ['submitter', 'subject', 'body'],
                },
              }
            : undefined,
          filter: {
            range: {
              createdOn: {
                gte: startTime,
                lte: endTime,
              },
            },
          },
        },
      },
      fields: ['subject'],
      _source: false,
      sort: sortObj,
      from: page && limit && page * limit,
      size: limit,
      track_total_hits: true,
    },
  })

  const items = hits.map(
    ({
      _id: circularId,
      fields: {
        subject: [subject],
      },
    }: {
      _id: string
      fields: { subject: string[] }
    }) => ({
      circularId,
      subject,
    })
  )

  const totalPages = limit ? Math.ceil(totalItems / limit) : 1

  return { items, totalPages, totalItems }
}

/** Get a circular by ID. */
export async function get(
  circularId: number,
  version?: number
): Promise<Circular> {
  const circularVersions = await getDynamoDBVersionAutoIncrement(circularId)
  const result = await circularVersions.get(version)
  if (!result)
    throw new Response(null, {
      status: 404,
    })
  return result as Circular
}

/** Delete a circular by ID.
 * Throws an HTTP error if:
 *  - The current user is not signed in
 *  - The current user is not in the moderator group
 */
export async function remove(circularId: number, request: Request) {
  const user = await getUser(request)
  if (!user?.groups.includes('gcn.nasa.gov/circular-moderator'))
    throw new Response('User is not a moderator', {
      status: 403,
    })

  const db = await tables()
  await db.circulars.delete({ circularId })
}

/**
 * Adds a new entry into the GCN Circulars table WITHOUT authentication
 */
export async function putRaw(
  item: Require<Omit<Circular, 'createdOn' | 'circularId'>, 'submittedHow'>
): Promise<Circular> {
  const autoincrement = await getDynamoDBAutoIncrement()
  const createdOn = Date.now()
  const circularId = await autoincrement.put({ createdOn, ...item })
  return { ...item, createdOn, circularId }
}

/**
 * Adds a new entry into the GCN Circulars table
 *
 * Throws an HTTP error if:
 *  - The current user is not signed in, verified by the class's #sub and #groups properties
 *  - The current user is not in the submitters group
 *  - Body or Subject are blank
 * @param body - main content of the Circular
 * @param subject - the title/subject line of the Circular
 */
export async function put(
  item: Require<
    Omit<
      Circular,
      'sub' | 'submitter' | 'createdOn' | 'circularId' | 'eventId'
    >,
    'submittedHow'
  >,
  user?: User
) {
  if (!user?.groups.includes(group))
    throw new Response('User is not in the submitters group', {
      status: 403,
    })

  validateCircular(item)

  const circular: Parameters<typeof putRaw>[0] = {
    sub: user.sub,
    submitter: formatAuthor(user),
    ...item,
  }

  const eventId = parseEventFromSubject(item.subject)
  if (eventId) circular.eventId = eventId

  return await putRaw(circular)
}

export async function circularRedirect(query: string) {
  const validCircularSearchStyles =
    /^\s*(?:GCN)?\s*(?:CIRCULAR)?\s*(-?\d+(?:\.\d)?)\s*$/i
  const circularId = parseFloat(
    validCircularSearchStyles.exec(query)?.[1] || ''
  )
  if (!isNaN(circularId)) {
    const db = await tables()
    const result = await db.circulars.get({ circularId })
    if (!result) return
    const circularURL = `/circulars/${circularId}`
    throw redirect(circularURL)
  }
}

export async function putVersion(
  circular: Omit<Circular, 'createdOn' | 'submitter' | 'submittedHow'>,
  user?: User
): Promise<number> {
  validateCircular(circular)
  if (!user?.groups.includes(moderatorGroup))
    throw new Response('User is not a moderator', {
      status: 403,
    })
  const circularVersionsAutoIncrement = await getDynamoDBVersionAutoIncrement(
    circular.circularId
  )

  // Need to be retrieved otherwise will be absent in latest version
  const oldCircular = await get(circular.circularId)

  const newCircularVersion = {
    ...oldCircular,
    ...circular,
    editedBy: formatAuthor(user),
    editedOn: Date.now(),
  }
  validateCircular(newCircularVersion)

  return await circularVersionsAutoIncrement.put(newCircularVersion)
}

/**
 * Gets all entries in circulars_history for a given circularId
 * @param circularId
 * @returns an array of previous versions of a Circular sorted by version
 */
export async function getVersions(circularId: number): Promise<number[]> {
  const circularVersionsAutoIncrement =
    await getDynamoDBVersionAutoIncrement(circularId)
  return await circularVersionsAutoIncrement.list()
}

/**
 * Creates a set of changes in circulars_change_requests for users
 * who do not have moderator permissions
 *
 * Throws an HTTP error if:
 *  - The subject is invalid
 *  - The body is invalid
 *  - The user is not signed in
 *
 * @param circularId
 * @param body
 * @param subject
 * @param request
 */
export async function createChangeRequest(
  item: Omit<
    Circular,
    | 'sub'
    | 'createdOn'
    | 'submitter'
    | 'submittedHow'
    | 'bibcode'
    | 'editedBy'
    | 'version'
    | 'editedOn'
  >,
  user?: User
) {
  validateCircular(item)
  if (!user)
    throw new Response('User is not signed in', {
      status: 403,
    })
  const requestor = formatAuthor(user)
  const db = await tables()
  await db.circulars_change_requests.put({
    ...item,
    requestorSub: user.sub,
    requestor,
  })
}

/**
 * Get all pending change requests
 * @returns
 */
export async function getChangeRequests(): Promise<CircularChangeRequest[]> {
  const db = await tables()
  const client = db._doc as unknown as DynamoDBDocument
  const TableName = db.name('circulars_change_requests')

  const pages = paginateScan({ client }, { TableName })
  const changeRequests: CircularChangeRequest[] = []
  for await (const page of pages) {
    const newRequests = page.Items as CircularChangeRequest[]
    if (newRequests) changeRequests.push(...newRequests)
  }

  return changeRequests
}

/**
 * Verifies the current user and deletes a specific change request.
 *
 * Throws an HTTP error if:
 *  - The current user is not signed in
 *  - The current user is not the same as the user who requested
 *    the changed, OR the current user is not a moderator
 *
 * @param circularId
 * @param requestorSub
 * @param user
 */
export async function deleteChangeRequest(
  circularId: number,
  requestorSub: string,
  user: User
): Promise<void> {
  if (!user) throw new Response(null, { status: 403 })
  if (requestorSub !== user.sub || !user.groups.includes(moderatorGroup))
    throw new Response(
      'Change requests may only be deleted by the user that submitted them or moderators',
      { status: 403 }
    )

  await deleteChangeRequestRaw(circularId, requestorSub)
}

/**
 * Delete a specific change request
 * @param circularId
 */
async function deleteChangeRequestRaw(
  circularId: number,
  requestorSub: string
) {
  const db = await tables()
  await db.circulars_change_requests.delete({
    circularId,
    requestorSub,
  })
}

/**
 * Applies the change request on behalf of the original author. This
 * method creates a new version and deletes the change
 * request once completed
 *
 * Throws an HTTP error if:
 *  - The current user is not a moderator
 *
 * @param circularId
 * @param user
 */
export async function approveChangeRequest(
  circularId: number,
  requestorSub: string,
  user: User
) {
  if (!user?.groups.includes(moderatorGroup))
    throw new Response('User is not in the moderators group', {
      status: 403,
    })

  const changeRequest = await getChangeRequest(circularId, requestorSub)
  const circular = await get(circularId)
  const autoincrementVersion = await getDynamoDBVersionAutoIncrement(circularId)

  await autoincrementVersion.put({
    ...circular,
    body: changeRequest.body,
    subject: changeRequest.subject,
    editedBy: `${formatAuthor(user)} on behalf of ${changeRequest.requestor}`,
    editedOn: Date.now(),
  })

  await deleteChangeRequestRaw(circularId, requestorSub)
}

/**
 * Gets the change request for a given circular
 * @param circularId
 * @param requestorSub
 * @returns
 */
export async function getChangeRequest(
  circularId: number,
  requestorSub: string
) {
  const db = await tables()
  const changeRequest = (await db.circulars_change_requests.get({
    circularId,
    requestorSub,
  })) as CircularChangeRequest

  if (!changeRequest)
    throw new Response('No change request found', { status: 404 })
  return changeRequest
}

function validateCircular({
  body,
  subject,
  format,
}: Pick<Circular, 'body' | 'subject' | 'format'>) {
  if (!subjectIsValid(subject))
    throw new Response('subject is invalid', { status: 400 })
  if (!bodyIsValid(body)) throw new Response('body is invalid', { status: 400 })
  if (!(format === undefined || formatIsValid(format)))
    throw new Response('format is invalid', { status: 400 })
}
