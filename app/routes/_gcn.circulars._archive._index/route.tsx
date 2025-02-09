/*!
 * Copyright © 2023 United States Government as represented by the
 * Administrator of the National Aeronautics and Space Administration.
 * All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node'
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useSearchParams,
  useSubmit,
} from '@remix-run/react'
import {
  Alert,
  Button,
  ButtonGroup,
  Icon,
  Label,
  Select,
  TextInput,
} from '@trussworks/react-uswds'
import clamp from 'lodash/clamp'
import { useId, useState } from 'react'

import { getUser } from '../_gcn._auth/user.server'
import {
  type CircularFormat,
  circularFormats,
} from '../_gcn.circulars/circulars.lib'
import {
  circularRedirect,
  createChangeRequest,
  get,
  getChangeRequests,
  put,
  putVersion,
  search,
} from '../_gcn.circulars/circulars.server'
import CircularPagination from './CircularPagination'
import CircularsHeader from './CircularsHeader'
import CircularsIndex from './CircularsIndex'
import { DateSelector } from './DateSelectorMenu'
import { SortSelector } from './SortSelectorButton'
import Hint from '~/components/Hint'
import { feature } from '~/lib/env.server'
import { getFormDataString } from '~/lib/utils'
import { useModStatus } from '~/root'

import searchImg from 'nasawds/src/img/usa-icons-bg/search--white.svg'

export async function loader({ request: { url } }: LoaderFunctionArgs) {
  const { searchParams } = new URL(url)
  const query = searchParams.get('query') || undefined
  if (query) {
    await circularRedirect(query)
  }
  const startDate = searchParams.get('startDate') || undefined
  const endDate = searchParams.get('endDate') || undefined
  const page = parseInt(searchParams.get('page') || '1')
  const limit = clamp(parseInt(searchParams.get('limit') || '100'), 1, 100)
  const sort = searchParams.get('sort') || 'circularId'
  const results = await search({
    query,
    page: page - 1,
    limit,
    startDate,
    endDate,
    sort,
  })
  const requestedChangeCount = (await getChangeRequests()).length
  return { page, ...results, requestedChangeCount }
}

export async function action({ request }: ActionFunctionArgs) {
  const data = await request.formData()
  const body = getFormDataString(data, 'body')
  const subject = getFormDataString(data, 'subject')
  const intent = getFormDataString(data, 'intent')
  let format
  if (feature('CIRCULARS_MARKDOWN')) {
    format = getFormDataString(data, 'format') as CircularFormat | undefined
    if (format && !circularFormats.includes(format)) {
      throw new Response('Invalid format', { status: 400 })
    }
  } else {
    format = undefined
  }
  if (!body || !subject)
    throw new Response('Body and subject are required', { status: 400 })
  const user = await getUser(request)
  const circularId = getFormDataString(data, 'circularId')

  let newCircular
  const props = { body, subject, ...(format ? { format } : {}) }
  switch (intent) {
    case 'correction':
      if (!circularId)
        throw new Response('circularId is required', { status: 400 })
      await createChangeRequest(
        { circularId: parseFloat(circularId), ...props },
        user
      )
      newCircular = null
      break
    case 'edit':
      if (!circularId)
        throw new Response('circularId is required', { status: 400 })
      await putVersion(
        {
          circularId: parseFloat(circularId),
          ...props,
        },
        user
      )
      newCircular = await get(parseFloat(circularId))
      break
    case 'new':
      newCircular = await put({ ...props, submittedHow: 'web' }, user)
      break
    default:
      break
  }
  return { newCircular, intent }
}

export default function () {
  const result = useActionData<typeof action>()
  const { items, page, totalPages, totalItems, requestedChangeCount } =
    useLoaderData<typeof loader>()

  // Concatenate items from the action and loader functions
  const allItems = [
    ...(result?.newCircular ? [result.newCircular] : []),
    ...(items || []),
  ]

  const [searchParams] = useSearchParams()
  const userIsModerator = useModStatus()

  // Strip off the ?index param if we navigated here from a form.
  // See https://remix.run/docs/en/main/guides/index-query-param.
  searchParams.delete('index')

  const limit = searchParams.get('limit') || '100'
  const query = searchParams.get('query') || undefined
  const startDate = searchParams.get('startDate') || undefined
  const endDate = searchParams.get('endDate') || undefined
  const sort = searchParams.get('sort') || 'circularID'

  let searchString = searchParams.toString()
  if (searchString) searchString = `?${searchString}`

  const [inputQuery, setInputQuery] = useState(query)
  const clean = inputQuery === query

  const formId = useId()
  const submit = useSubmit()

  return (
    <>
      {result?.intent === 'correction' && (
        <Alert
          type={'success'}
          headingLevel={'h1'}
          slim
          heading="Request Submitted"
        >
          Thank you for your correction. A GCN Circulars moderator will review
          it shortly.
        </Alert>
      )}
      <CircularsHeader />
      {userIsModerator && requestedChangeCount > 0 && (
        <Link to="moderation" className="usa-button usa-button--outline">
          Review {requestedChangeCount} Requested Change
          {requestedChangeCount > 1 ? 's' : ''}
        </Link>
      )}
      <ButtonGroup className="position-sticky top-0 bg-white margin-bottom-1 padding-top-1 z-300">
        <Form
          className="display-inline-block usa-search usa-search--small"
          role="search"
          id={formId}
        >
          <Label srOnly={true} htmlFor="query">
            Search
          </Label>
          <TextInput
            autoFocus
            id="query"
            name="query"
            type="search"
            defaultValue={inputQuery}
            placeholder="Search"
            aria-describedby="searchHint"
            onChange={({ target: { form, value } }) => {
              setInputQuery(value)
              if (!value) submit(form)
            }}
          />
          <Button type="submit">
            <img
              src={searchImg}
              className="usa-search__submit-icon"
              alt="Search"
            />
          </Button>
        </Form>
        <DateSelector
          form={formId}
          defaultStartDate={startDate}
          defaultEndDate={endDate}
        />
        {query && <SortSelector form={formId} defaultValue={sort} />}
        <Link to={`/circulars/new${searchString}`}>
          <Button
            type="button"
            className="height-4 padding-top-0 padding-bottom-0"
          >
            <Icon.Edit role="presentation" /> New
          </Button>
        </Link>
      </ButtonGroup>
      <Hint id="searchHint">
        Search for Circulars by submitter, subject, or body text (e.g. 'Fermi
        GRB'). <br />
        To navigate to a specific circular, enter the associated Circular ID
        (e.g. 'gcn123', 'Circular 123', or '123').
      </Hint>
      {clean && (
        <>
          <CircularsIndex
            allItems={allItems}
            searchString={searchString}
            totalItems={totalItems}
            query={query}
          />
          <div className="display-flex flex-row flex-wrap">
            <div className="display-flex flex-align-self-center margin-right-2 width-auto">
              <div>
                <Select
                  id="limit"
                  className="width-auto height-5 padding-y-0 margin-y-0"
                  name="limit"
                  defaultValue="100"
                  form="searchForm"
                  onChange={({ target: { form } }) => {
                    submit(form)
                  }}
                >
                  <option value="10">10 / page</option>
                  <option value="20">20 / page</option>
                  <option value="50">50 / page</option>
                  <option value="100">100 / page</option>
                </Select>
              </div>
            </div>
            <div className="display-flex flex-fill">
              {totalPages > 1 && (
                <CircularPagination
                  query={query}
                  page={page}
                  limit={parseInt(limit)}
                  totalPages={totalPages}
                  startDate={startDate}
                  endDate={endDate}
                />
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
