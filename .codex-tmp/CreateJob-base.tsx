import SearchLocation from "@/components/locationSearchComponent"
import {
  RecurringJobSection,
  defaultRecurring,
} from "@/components/RecurringJobSection"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import customFetch from "@/utils/customFetch"
import { createJobSchema } from "@/utils/schemas"
import type { User } from "@/utils/types"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { isAxiosError } from "axios"
import { AnimatePresence, motion } from "framer-motion"
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  MapPin,
  Paperclip,
  Receipt,
  Settings2,
  Users,
  X,
} from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import toast from "react-hot-toast"
import {
  Form,
  redirect,
  useLoaderData,
  useNavigate,
  useNavigation,
  type ActionFunctionArgs,
  type Params,
} from "react-router"
import { Avatar, Input } from "../components/ui"
import type { RecurringState } from "@/components/RecurringJobSection"
import { mapRecurringStateToPayload } from "@/utils/mapRecurringStateToPayload"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Field, FieldContent, FieldLabel } from "@/components/ui/field"
import dayjs from "dayjs"
import { formatCurrency } from "@/utils/format"
import { Label } from "@/components/ui/label"
import {
  ApplyRatePrompt,
  ClientCombobox,
  type ComboboxClient,
} from "@/components/client/ClientCombobox"
import { CreateJobHiddenFields } from "@/components/create-job/CreateJobHiddenFields"
import type { z } from "zod"

type Values = z.infer<typeof createJobSchema>

const FieldError = ({ message }: { message?: string }) => {
  if (!message) return null
  return <p className="text-sm text-red-500 mt-1">{message}</p>
}

/** Shift length in hours. Handles overnight shifts, where the end time
 *  is earlier than the start. */
function shiftHoursFrom(startTime?: string, endTime?: string): number {
  if (!startTime || !endTime) return 0
  const [sh, sm] = startTime.split(":").map(Number)
  const [eh, em] = endTime.split(":").map(Number)
  if ([sh, sm, eh, em].some(Number.isNaN)) return 0
  let mins = eh * 60 + em - (sh * 60 + sm)
  if (mins <= 0) mins += 24 * 60
  return mins / 60
}

function formatHours(hours: number): string {
  const total = Math.round(hours * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const workersQuery = (params: Params) => {
  const { search, sort, page, status, date } = params
  // params.role = "worker"
  return {
    queryKey: [
      "workers",
      {
        search: search ?? "",
        status: status ?? "all",
        sort: sort ?? "asc",
        page: page ?? 1,
        date: date ?? "",
      },
    ],
    queryFn: async () => {
      const { data } = await customFetch.get<any>("/users/users", {
        params: {
          ...params,
          role: "worker", //query the data base for only when a user role is a worker
        },
      })
      return data
    },
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData()
  const raw = Object.fromEntries(formData) as Record<string, string>
  const payload: Record<string, unknown> = { ...raw }

  // Invoice fields are handled separately below — don't send them as job fields
  delete payload.generateInvoice
  delete payload.invoiceDueDate
  delete payload.invoiceLineItems
  // FormData is all strings — restore the real types.
  ;[
    "geofenceRadiusMeters",
    "interval",
    "payRate",
    "chargeRate",
    "chargeAmount",
    "requiredWorkers",
    "clockInGraceMinutes",
  ].forEach((key) => {
    if (raw[key]) payload[key] = Number(raw[key])
    else delete payload[key]
  })
  payload.isRecurring = raw.isRecurring === "true"
  payload.openToClaims = raw.openToClaims === "true"
  payload.requiresApproval = raw.requiresApproval === "true"
  ;["daysOfWeek", "coordinates", "workers"].forEach((key) => {
    if (raw[key]) {
      try {
        payload[key] = JSON.parse(raw[key])
      } catch {
        delete payload[key]
      }
    } else delete payload[key]
  })
  ;["endDate", "frequency", "supervisor", "geofenceMode"].forEach((key) => {
    if (!raw[key]) delete payload[key]
  })

  try {
    const { data } = await customFetch.post("/jobs", payload)
    toast.success("Job created successfully!")

    if (raw.generateInvoice === "true" && raw.invoiceLineItems) {
      try {
        const lineItems = JSON.parse(raw.invoiceLineItems)
        const jobId = data?.job?._id ?? data?.templateJob?._id ?? data?._id
        await customFetch.post("/invoices", {
          job: jobId,
          client: raw.client,
          issueDate: dayjs().format("YYYY-MM-DD"),
          dueDate: raw.invoiceDueDate,
          lineItems,
          status: "draft",
        })
        toast.success("Draft invoice created")
      } catch {
        // The job saved either way — surface the invoice failure separately
        toast.error(
          "Job created, but the invoice could not be generated. You can create it from the job page.",
        )
      }
    }

    return redirect("/jobs")
  } catch (err) {
    let errorM
    if (isAxiosError(err)) {
      errorM = err.response?.data?.msg ?? err.response?.data ?? null
    }
    errorM =
      errorM ?? (err instanceof Error ? err.message : "Something went wrong")
    toast.error(errorM, { position: "bottom-center" })
    return errorM
  }
}

type SelectedWorker = {
  fullname: string
  email: string
  phone: string
  user: string
}

export function CreateJob() {
  const [selectedWorkers, setSelectedWorkers] = useState<SelectedWorker[]>([])
  const [workerOpen, setWorkerOpen] = useState(false)
  const [generateInvoice, setGenerateInvoice] = useState(false)
  const [invoiceDueDate, setInvoiceDueDate] = useState(() =>
    dayjs().add(14, "day").format("YYYY-MM-DD"),
  )
  const [invoiceRates, setInvoiceRates] = useState<Record<string, number>>({})
  const [selectedClient, setSelectedClient] = useState<ComboboxClient | null>(
    null,
  )
  const [showApplyRate, setShowApplyRate] = useState(false)
  const [previousRate, setPreviousRate] = useState<number | null>(null)
  const [clientToast, setClientToast] = useState<string | null>(null)

  const navigate = useNavigate()
  const onNavigate = (path: string) => navigate(path)
  const navigation = useNavigation()

  // RHF's isSubmitting only covers client-side validation — it flips back to
  // false as soon as `onValid` returns, before the actual POST /jobs resolves.
  const isFormSubmitting =
    navigation.state === "submitting" || navigation.state === "loading"

  const [recurring, setRecurring] = useState<RecurringState>(defaultRecurring)
  const { searchValues } = useLoaderData() as any

  const workersResult = useQuery<{ users: User[] }>(workersQuery(searchValues))
  const users = (workersResult.data?.users ?? []).filter(
    (user) => user.role === "worker",
  )
  const {
    register,
    setValue,
    watch,
    trigger,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(createJobSchema) as any,
    shouldUnregister: false,
    defaultValues: {
      title: "",
      description: "",
      client: "",
      priority: "medium",
      date: "",
      startTime: "",
      endTime: "",
      workers: [],
      additional_notes: "",
      location: "",
      address: "",
      coordinates: undefined,
      payRate: 0,
      chargeRate: 0,
      chargeAmount: 0,
      chargeType: "hourly",
      requiredWorkers: 1,
      geofenceMode: undefined,
      geofenceRadiusMeters: 150,
      supervisor: undefined,
      instructions: "",
      notes: "",
      openToClaims: false,
      requiresApproval: true,
      clockInGraceMinutes: undefined,
    },
    mode: "onSubmit",
    reValidateMode: "onChange",
  })

  const [advancedOpen, setAdvancedOpen] = useState(false)
  const startTime = watch("startTime")
  const endTime = watch("endTime")
  const priority = watch("priority")
  const date = watch("date")
  const address = watch("address")
  const coordinates = watch("coordinates")
  const payRate = watch("payRate") ?? 0
  const chargeRate = watch("chargeRate") ?? 0
  const chargeAmount = watch("chargeAmount") ?? 0
  const chargeType = watch("chargeType") ?? "hourly"
  const requiredWorkers = watch("requiredWorkers") ?? 1
  const geofenceMode = watch("geofenceMode")
  const geofenceRadius = watch("geofenceRadiusMeters") ?? 150
  const supervisor = watch("supervisor")
  const openToClaims = watch("openToClaims") ?? false
  const requiresApproval = watch("requiresApproval") ?? true
  const clockInGraceMinutes = watch("clockInGraceMinutes")
  const recurringPayload = mapRecurringStateToPayload(recurring)
  const shiftHours = shiftHoursFrom(startTime, endTime)

  const supervisorUser = users.find((u) => u._id === supervisor)
  const advancedSummaryParts: string[] = []
  if (supervisorUser)
    advancedSummaryParts.push(`Supervisor: ${supervisorUser.fullname}`)
  if (openToClaims)
    advancedSummaryParts.push(
      `Open to claims${requiresApproval ? "" : " (auto-approved)"}`,
    )
  if (clockInGraceMinutes)
    advancedSummaryParts.push(`Grace: ${clockInGraceMinutes}m`)
  if (geofenceMode)
    advancedSummaryParts.push(
      `Clock-in location: ${geofenceMode} · ${geofenceRadius}m`,
    )
  const advancedSummary =
    advancedSummaryParts.length > 0
      ? advancedSummaryParts.join(" · ")
      : "Using company defaults · No supervisor assigned"

  // Invoice rates default to the job's charge rate rather than making the
  // manager type the same figure twice
  const invoiceLineItems = selectedWorkers.map((w) => ({
    description: w.fullname,
    hours: shiftHours,
    rate: invoiceRates[w.email] ?? chargeRate,
  }))
  const invoiceSubtotal = invoiceLineItems.reduce(
    (sum, li) => sum + li.hours * li.rate,
    0,
  )

  const totalCost = payRate * shiftHours * Math.max(selectedWorkers.length, 1)
  const totalCharge =
    chargeType === "fixed" ? chargeAmount : chargeRate * shiftHours
  const margin = totalCharge - totalCost

  const toggleWorker = (email: string) => {
    // alert("")
    // console.log("email here in the console: ",email)
    const exists = selectedWorkers.some((w) => w.email === email)

    const next = exists
      ? selectedWorkers.filter((w) => w.email !== email)
      : (() => {
          const worker = users.find((w) => w.email === email)
          return worker
            ? [
                ...selectedWorkers,
                {
                  fullname: worker.fullname,
                  email: worker.email,
                  phone: "",
                  user: worker._id,
                },
              ]
            : selectedWorkers
        })()

    setSelectedWorkers(next)
    setValue("workers", next as any, { shouldValidate: true })
  }

  const applyClientRate = (client = selectedClient) => {
    if (!client) return
    const type = client.defaultChargeType ?? "hourly"
    setValue("chargeType", type, { shouldValidate: true })
    setValue(
      type === "fixed" ? "chargeAmount" : "chargeRate",
      client.defaultChargeRate ?? 0,
      { shouldValidate: true },
    )
    setShowApplyRate(false)
  }

  const handleClientSelect = (client: ComboboxClient | null) => {
    setSelectedClient(client)
    setValue("client", client?._id ?? "", { shouldValidate: true })
    setShowApplyRate(false)

    if (client?.defaultChargeRate != null) {
      const currentRate = chargeType === "fixed" ? chargeAmount : chargeRate
      const rateDiffers =
        currentRate > 0 && currentRate !== client.defaultChargeRate
      const typeDiffers = chargeType !== (client.defaultChargeType ?? "hourly")

      if (rateDiffers || (currentRate > 0 && typeDiffers)) {
        setPreviousRate(currentRate)
        setShowApplyRate(true)
      } else {
        applyClientRate(client)
      }
    }
  }

  const publish = async () => {
    if (!(await trigger())) {
      toast.error("Please fix the highlighted fields before publishing.")
      return
    }

    const submitButton = document.getElementById(
      "publish-job",
    ) as HTMLButtonElement | null
    submitButton?.form?.requestSubmit(submitButton)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-7">
        <button
          type="button"
          onClick={() => onNavigate("/jobs")}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <div>
          <h1 className="text-xl font-semibold text-slate-900 tracking-tight">
            Create New Job
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Fill in the details to assign work to your team
          </p>
        </div>
      </div>

      <Form className="flex flex-col gap-5" method="post">
        {/* 1 — Job Details */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold">
              1
            </span>
            Job Details
          </h2>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <Input
                label="Job Name"
                placeholder="e.g. Canary Wharf Security — Night Shift"
                {...register("title")}
                className={cn(errors.title && "border-red-500!")}
              />
              <FieldError message={errors.title?.message} />
            </div>

            <div>
              <Textarea
                {...register("description")}
                placeholder="Brief description of the work required..."
                className={cn(errors.description && "border-red-500!")}
              />
              <FieldError message={errors.description?.message} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                  Client
                </p>
                <ClientCombobox
                  value={selectedClient}
                  onChange={handleClientSelect}
                  onToast={(message) => {
                    setClientToast(message)
                    setTimeout(() => setClientToast(null), 3000)
                  }}
                />
                <FieldError message={errors.client?.message} />
                {showApplyRate && selectedClient && previousRate !== null && (
                  <div className="mt-2">
                    <ApplyRatePrompt
                      client={selectedClient}
                      currentRate={previousRate}
                      onKeep={() => setShowApplyRate(false)}
                      onApply={() => applyClientRate()}
                    />
                  </div>
                )}
                {clientToast && (
                  <p className="mt-1.5 text-xs font-semibold text-emerald-600">
                    {clientToast}
                  </p>
                )}
              </div>

              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                  Priority
                </p>
                <RadioGroup
                  value={priority}
                  onValueChange={(v) =>
                    setValue("priority", v as any, { shouldValidate: true })
                  }
                  name="priority"
                  className="flex flex-wrap gap-x-4 gap-y-2"
                >
                  {[
                    { value: "low", label: "Low", className: "text-slate-700" },
                    {
                      value: "medium",
                      label: "Medium",
                      className: "text-amber-600",
                    },
                    {
                      value: "high",
                      label: "High",
                      className: "text-orange-600",
                    },
                    {
                      value: "urgent",
                      label: "Urgent",
                      className: "text-red-600",
                    },
                  ].map((item) => (
                    <Field key={item.value} orientation="horizontal">
                      <RadioGroupItem
                        value={item.value}
                        id={`priority-${item.value}`}
                      />
                      <FieldContent>
                        <FieldLabel
                          htmlFor={`priority-${item.value}`}
                          className={cn("font-medium", item.className)}
                        >
                          {item.label}
                        </FieldLabel>
                      </FieldContent>
                    </Field>
                  ))}
                </RadioGroup>
                <FieldError message={errors.priority?.message} />
              </div>
            </div>
          </div>
        </div>

        {/* 2 — Location */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold">
              2
            </span>
            Location
          </h2>
          <SearchLocation
            defaultQuery={address}
            onSelect={(location) => {
              setValue("location", location.siteName, { shouldValidate: true })
              setValue(
                "address",
                [location.address, location.city, location.postcode]
                  .filter(Boolean)
                  .join(", "),
                { shouldValidate: true },
              )
              setValue(
                "coordinates",
                { lat: location.lat, lng: location.lng },
                { shouldValidate: true },
              )
            }}
          />
          <FieldError message={errors.location?.message} />

          {address && (
            <>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                <MapPin size={12} className="text-slate-400" /> {address}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                Only the general area is shown to workers before they're
                assigned — the exact address is used for directions once someone
                is.
              </p>
            </>
          )}

          {/* <Form> submits from the DOM, not RHF state, so these need real Inputs */}
          <Input type="hidden" name="address" value={address ?? ""} />
          {coordinates && (
            <Input
              type="hidden"
              name="coordinates"
              value={JSON.stringify(coordinates)}
            />
          )}

          <div className="mt-3 h-36 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center overflow-hidden">
            <div className="text-center">
              <MapPin size={20} className="text-slate-400 mx-auto mb-1" />
              <p className="text-xs text-slate-400">
                Map preview will appear here
              </p>
            </div>
          </div>
        </div>

        {/* 3 — Date & Time */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold">
              3
            </span>
            Date & Time
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 min-w-0">
            <div className="min-w-0">
              <Input
                label="Date"
                min={dayjs().format("YYYY-MM-DD")}
                type="date"
                icon={<Calendar size={14} />}
                {...register("date")}
                className={cn(errors.date && "border-red-500!")}
              />
              <FieldError message={errors.date?.message} />
            </div>

            <div className="min-w-0">
              <Input
                label="Start Time"
                type="time"
                icon={<Clock size={14} />}
                {...register("startTime")}
                className={cn(errors.startTime && "border-red-500!")}
              />
              <FieldError message={errors.startTime?.message} />
            </div>

            <div className="min-w-0">
              <Input
                label="End Time"
                type="time"
                icon={<Clock size={14} />}
                {...register("endTime")}
                className={cn(errors.endTime && "border-red-500!")}
              />
              <FieldError message={errors.endTime?.message} />
            </div>
          </div>

          {shiftHours > 0 && (
            <div className="mt-3 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2.5 flex items-center gap-2">
              <Clock size={14} className="text-blue-500 shrink-0" />
              <p className="text-sm text-blue-700">
                <span className="font-semibold">{formatHours(shiftHours)}</span>{" "}
                shift duration
                {endTime < startTime && (
                  <span className="text-blue-500"> · overnight</span>
                )}
              </p>
            </div>
          )}
        </div>

        {/* 4 — Recurring */}
        <RecurringJobSection
          value={recurring}
          onChange={setRecurring}
          startDate={date}
          sectionIndex={4}
        />
        <Input
          type="hidden"
          name="isRecurring"
          value={String(recurringPayload.isRecurring)}
        />
        {recurringPayload.frequency && (
          <Input
            type="hidden"
            name="frequency"
            value={recurringPayload.frequency}
          />
        )}
        {recurringPayload.interval !== undefined && (
          <Input
            type="hidden"
            name="interval"
            value={String(recurringPayload.interval)}
          />
        )}
        {recurringPayload.daysOfWeek && (
          <Input
            type="hidden"
            name="daysOfWeek"
            value={JSON.stringify(recurringPayload.daysOfWeek)}
          />
        )}
        {recurringPayload.endDate && (
          <Input
            type="hidden"
            name="endDate"
            value={recurringPayload.endDate}
          />
        )}

        {/* 5 — Assign Workers */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold">
              5
            </span>
            Assign Workers
          </h2>

          <button
            type="button"
            onClick={() => setWorkerOpen((o) => !o)}
            className="w-full flex items-center justify-between h-9 px-3 border border-[#E2E8F0] rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Users size={14} className="text-slate-400 shrink-0" />
              <span className="truncate">
                {selectedWorkers.length > 0
                  ? `${selectedWorkers.length} worker${
                      selectedWorkers.length > 1 ? "s" : ""
                    } selected`
                  : "Select workers..."}
              </span>
            </span>
            <ChevronDown
              size={14}
              className={cn(
                "text-slate-400 transition-transform shrink-0",
                workerOpen && "rotate-180",
              )}
            />
          </button>

          <Input
            type="hidden"
            name="workers"
            value={JSON.stringify(selectedWorkers)}
          />
          <FieldError message={errors.workers?.message as string | undefined} />

          {workerOpen && (
            <div className="mt-2 border border-[#E2E8F0] rounded-xl overflow-hidden animate-fade-in">
              {users.map((w, i) => {
                const selected = selectedWorkers.some(
                  (sw) => sw.email === w.email,
                )
                return (
                  <button
                    type="button"
                    key={w._id}
                    onClick={() => toggleWorker(w.email)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors border-b border-[#F1F5F9] last:border-0",
                      selected && "bg-blue-50/40",
                    )}
                  >
                    <Avatar
                      initials={w.fullname.slice(0, 2)}
                      size="sm"
                      index={i}
                    />
                    <div className="flex-1 text-left min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">
                        {w.fullname}
                      </p>
                      <p className="text-xs text-slate-400">{w.role}</p>
                    </div>
                    <div
                      className={cn(
                        "w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all shrink-0",
                        selected
                          ? "bg-[#1E3A5F] border-[#1E3A5F]"
                          : "border-slate-300",
                      )}
                    >
                      {selected && <Check size={11} className="text-white" />}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {selectedWorkers.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {selectedWorkers.map((sw) => {
                const w = users.find((u) => u.email === sw.email)
                if (!w) return null
                return (
                  <div
                    key={sw.email}
                    className="flex items-center gap-1.5 bg-blue-50 border border-blue-200 rounded-full pl-1.5 pr-2 py-0.5"
                  >
                    <span className="text-xs font-medium text-blue-700">
                      {w.fullname.split(" ")[0]}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleWorker(sw.email)}
                      className="text-blue-400 hover:text-blue-600"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 6 — Rates & Billing */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6 hidde">
          <h2 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold">
              6
            </span>
            Rates & Billing
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
            <div className="min-w-0">
              <Input
                label="Worker Pay Rate"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                icon={
                  <span className="text-slate-400 text-xs font-semibold">
                    £
                  </span>
                }
                {...register("payRate", { valueAsNumber: true })}
                className={cn(errors.payRate && "border-red-500!")}
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Per hour, paid to each assigned worker
              </p>
              <FieldError message={errors.payRate?.message} />
            </div>

            <div className="min-w-0">
              <Input
                label="Workers Needed"
                type="number"
                min="1"
                {...register("requiredWorkers", { valueAsNumber: true })}
                className={cn(errors.requiredWorkers && "border-red-500!")}
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {selectedWorkers.length} of {requiredWorkers || 1} assigned
                {selectedWorkers.length < (requiredWorkers || 1) &&
                  " — the rest stay open"}
              </p>
              <FieldError message={errors.requiredWorkers?.message} />
            </div>
          </div>

          <div className="mt-5 pt-5 border-t border-[#F1F5F9] min-w-0">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
              How you're billing the client
            </p>

            <RadioGroup
              value={chargeType}
              onValueChange={(v) =>
                setValue("chargeType", v as "hourly" | "fixed", {
                  shouldValidate: true,
                })
              }
              name="chargeType"
              className="flex flex-col sm:flex-row gap-3 mb-4 min-w-0 "
            >
              {[
                {
                  value: "hourly",
                  label: "Hourly rate",
                  sub: "Bills by hours worked",
                },
                {
                  value: "fixed",
                  label: "Fixed price",
                  sub: "One agreed total, whatever the hours",
                },
              ].map((opt) => (
                <Label
                  key={opt.value}
                  className={cn(
                    // "flex-1 min-w-0 flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ",
                    chargeType === opt.value
                      ? "border-[#1E3A5F] bg-[#1E3A5F]/[0.03]"
                      : "border-[#E2E8F0] hover:border-slate-300",
                  )}
                >
                  {/* <RadioGroupItem value={opt.value} id={`charge-${opt.value}`} className="mt-0.5 shrink-0" /> */}
                  <label
                    key={opt.value}
                    className={cn(
                      "flex-1 min-w-0 flex items-start gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all",
                      chargeType === opt.value
                        ? "border-[#1E3A5F] bg-[#1E3A5F]/[0.03]"
                        : "border-[#E2E8F0] hover:border-slate-300",
                    )}
                  >
                    <Input
                      type="radio"
                      className="sr-only"
                      name="chargeType"
                      value={opt.value}
                      checked={chargeType === opt.value}
                      onChange={() =>
                        setValue(
                          "chargeType",
                          opt.value as "hourly" | "fixed",
                          { shouldValidate: true },
                        )
                      }
                    />
                    <span
                      className={cn(
                        "mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
                        chargeType === opt.value
                          ? "border-[#1E3A5F] bg-[#1E3A5F]"
                          : "border-slate-300",
                      )}
                    >
                      {chargeType === opt.value && (
                        <span className="w-1.5 h-1.5 rounded-full bg-white" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-800">
                        {opt.label}
                      </span>
                      <span className="block text-[11px] text-slate-400 mt-0.5">
                        {opt.sub}
                      </span>
                    </span>
                  </label>
                </Label>
              ))}
            </RadioGroup>

            <AnimatePresence mode="wait">
              {chargeType === "fixed" ? (
                <motion.div
                  key="fixed"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="max-w-xs min-w-0"
                >
                  <Input
                    label="Fixed Price"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    icon={
                      <span className="text-slate-400 text-xs font-semibold">
                        £
                      </span>
                    }
                    {...register("chargeAmount", { valueAsNumber: true })}
                    className={cn(errors.chargeAmount && "border-red-500!")}
                  />
                  <FieldError message={errors.chargeAmount?.message} />
                </motion.div>
              ) : (
                <motion.div
                  key="hourly"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="max-w-xs min-w-0"
                >
                  <Input
                    label="Charge Rate"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    icon={
                      <span className="text-slate-400 text-xs font-semibold">
                        £
                      </span>
                    }
                    {...register("chargeRate", { valueAsNumber: true })}
                    className={cn(errors.chargeRate && "border-red-500!")}
                  />
                  <FieldError message={errors.chargeRate?.message} />
                </motion.div>
              )}
            </AnimatePresence>

            {shiftHours > 0 && (payRate > 0 || totalCharge > 0) && (
              <div className="mt-4 grid grid-cols-3 gap-3 min-w-0">
                {[
                  { label: "Cost", value: totalCost },
                  { label: "Charge", value: totalCharge },
                  { label: "Margin", value: margin, highlight: true },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="bg-slate-50 rounded-xl p-3 text-center border border-slate-100 min-w-0"
                  >
                    <p
                      className={cn(
                        "text-sm font-bold truncate",
                        s.highlight
                          ? s.value >= 0
                            ? "text-emerald-600"
                            : "text-red-600"
                          : "text-slate-900",
                      )}
                    >
                      {formatCurrency(s.value)}
                    </p>
                    <p className="text-[10px] text-slate-400 mt-0.5 font-medium">
                      {s.label}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 7 — Invoice */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6 hidden">
          <label className="flex items-center gap-3 cursor-pointer">
            <Input
              type="checkbox"
              checked={generateInvoice}
              onChange={(e) => setGenerateInvoice(e.target.checked)}
              className="w-4 h-4 rounded border-[#E2E8F0] accent-[#1E3A5F] shrink-0"
            />
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold shrink-0">
              7
            </span>
            <span className="flex-1 min-w-0">
              <span className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                <Receipt size={14} className="text-slate-400 shrink-0" />{" "}
                Generate an invoice for this job
              </span>
              <span className="block text-xs text-slate-400 mt-0.5">
                Creates a draft using the client and workers above — send it
                once the job's done
              </span>
            </span>
          </label>

          {generateInvoice && (
            <div className="mt-4 pt-4 border-t border-[#F1F5F9] flex flex-col gap-4 animate-fade-in min-w-0">
              <div className="max-w-xs min-w-0">
                <Input
                  label="Invoice Due Date"
                  type="date"
                  value={invoiceDueDate}
                  onChange={(e) => setInvoiceDueDate(e.target.value)}
                />
              </div>

              {selectedWorkers.length === 0 ? (
                <p className="text-xs text-amber-600">
                  Select workers above to bill for their hours.
                </p>
              ) : (
                <div className="border border-[#E2E8F0] rounded-xl overflow-hidden min-w-0">
                  <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-4 py-2.5 bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    <span>Worker</span>
                    <span className="text-right">Hours</span>
                    <span className="text-right">Rate</span>
                    <span className="text-right">Amount</span>
                  </div>
                  {selectedWorkers.map((w) => {
                    const rate = invoiceRates[w.email] ?? chargeRate
                    return (
                      <div
                        key={w.email}
                        className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-4 py-2.5 border-t border-[#F1F5F9] items-center min-w-0"
                      >
                        <span className="text-sm text-slate-700 truncate">
                          {w.fullname}
                        </span>
                        <span className="text-sm text-right text-slate-600">
                          {formatHours(shiftHours)}
                        </span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={rate || ""}
                          onChange={(e) =>
                            setInvoiceRates((prev) => ({
                              ...prev,
                              [w.email]: Number(e.target.value),
                            }))
                          }
                          placeholder="0.00"
                          className="h-8 px-2 min-w-0 border border-[#E2E8F0] rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#3B82F6] transition-all"
                        />
                        <span className="text-sm text-right font-medium text-slate-900 truncate">
                          {formatCurrency(shiftHours * rate)}
                        </span>
                      </div>
                    )
                  })}
                  <div className="flex justify-end px-4 py-3 border-t border-[#F1F5F9] bg-slate-50/50">
                    <span className="text-sm font-bold text-slate-900">
                      Total: {formatCurrency(invoiceSubtotal)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hidden Inputs — <Form> submits from the DOM, not RHF state */}
        {geofenceMode && (
          <Input type="hidden" name="geofenceMode" value={geofenceMode} />
        )}
        {geofenceMode && geofenceMode !== "off" && geofenceRadius && (
          <Input
            type="hidden"
            name="geofenceRadiusMeters"
            value={String(geofenceRadius)}
          />
        )}
        <Input
          type="hidden"
          name="generateInvoice"
          value={String(generateInvoice)}
        />
        {generateInvoice && (
          <>
            <Input type="hidden" name="invoiceDueDate" value={invoiceDueDate} />
            <Input
              type="hidden"
              name="invoiceLineItems"
              value={JSON.stringify(invoiceLineItems)}
            />
          </>
        )}

        {/* 8 — Instructions & Attachments */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] p-6">
          <h2 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-[#1E3A5F] text-white flex items-center justify-center text-[10px] font-bold">
              8
            </span>
            Instructions & Attachments
          </h2>
          <Textarea
            {...register("instructions")}
            placeholder="Gate code, where to park, who to ask for..."
            rows={4}
            className={cn(errors.instructions && "border-red-500!")}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Workers assigned to this job will see this.
          </p>
          <FieldError message={errors.instructions?.message} />

          <button
            type="button"
            className="mt-3 flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 border border-dashed border-slate-300 rounded-lg w-full py-3 px-4 hover:bg-slate-50 transition-colors"
          >
            <Paperclip size={14} />
            Attach files, documents or images
          </button>
        </div>
        {/* Advanced — collapsed by default so the common case stays a short form */}
        <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-50/60 transition-colors"
          >
            <span className="flex items-center gap-2.5 min-w-0">
              <Settings2 size={15} className="text-slate-400 shrink-0" />
              <span className="text-left min-w-0">
                <span className="block text-sm font-semibold text-slate-800">
                  Advanced options
                </span>
                <span className="block text-[11px] text-slate-400 truncate">
                  {advancedSummary}
                </span>
              </span>
            </span>
            <ChevronDown
              size={15}
              className={cn(
                "text-slate-400 transition-transform shrink-0",
                advancedOpen && "rotate-180",
              )}
            />
          </button>

          <AnimatePresence initial={false}>
            {advancedOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                style={{ overflow: "hidden" }}
                className="min-w-0"
              >
                <div className="px-6 pb-6 pt-1 min-w-0 flex flex-col gap-6">
                  <div className="h-px bg-[#F1F5F9]" />

                  {/* Supervisor */}
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                      Supervisor
                    </p>
                    <p className="text-[11px] text-slate-400 mb-2">
                      The person workers should contact on site. Optional.
                    </p>
                    <div className="relative max-w-xs min-w-0">
                      <select
                        value={supervisor ?? ""}
                        onChange={(e) =>
                          setValue("supervisor", e.target.value || undefined, {
                            shouldValidate: true,
                          })
                        }
                        className="w-full h-10 pl-3 pr-8 border border-[#E2E8F0] rounded-lg text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#3B82F6]/30 focus:border-[#3B82F6] appearance-none cursor-pointer transition-all"
                      >
                        <option value="">No supervisor assigned</option>
                        {users.map((u) => (
                          <option key={u._id} value={u._id}>
                            {u.fullname}
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        size={12}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                      />
                    </div>
                    {supervisor && (
                      <Input
                        type="hidden"
                        name="supervisor"
                        value={supervisor}
                      />
                    )}
                  </div>

                  {/* Internal notes — manager-only, never shown to workers. Worker-visible
                      instructions stay in the main form (see section 8) since that's the
                      common case, not an edge case worth burying here. */}
                  <div className="min-w-0 pt-6 border-t border-[#F1F5F9]">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                      Internal notes
                    </p>
                    <p className="text-[11px] text-slate-400 mb-2">
                      Internal only — never shown to workers.
                    </p>
                    <Textarea
                      {...register("notes")}
                      placeholder="Anything the team should know but workers shouldn't see..."
                      rows={3}
                    />
                  </div>

                  {/* Open shifts */}
                  <div className="min-w-0 pt-6 border-t border-[#F1F5F9]">
                    <div className="flex items-center justify-between gap-3 min-w-0">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800">
                          Open to claims
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Lets any worker claim an unfilled slot on this shift.
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={openToClaims}
                        onClick={() =>
                          setValue("openToClaims", !openToClaims, {
                            shouldValidate: true,
                          })
                        }
                        className={cn(
                          "relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6] focus-visible:ring-offset-1 shrink-0",
                          openToClaims ? "bg-[#1E3A5F]" : "bg-slate-200",
                        )}
                      >
                        <motion.span
                          layout
                          transition={{
                            type: "spring",
                            stiffness: 500,
                            damping: 35,
                          }}
                          className={cn(
                            "absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm",
                            openToClaims ? "left-6" : "left-1",
                          )}
                        />
                      </button>
                    </div>

                    <AnimatePresence initial={false}>
                      {openToClaims && (
                        <motion.div
                          initial={{ opacity: 0, y: -6, height: 0 }}
                          animate={{ opacity: 1, y: 0, height: "auto" }}
                          exit={{ opacity: 0, y: -6, height: 0 }}
                          transition={{ duration: 0.18 }}
                          style={{ overflow: "hidden" }}
                          className="min-w-0"
                        >
                          <div className="flex items-center justify-between gap-3 min-w-0 mt-4 pl-4 border-l-2 border-slate-100">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-700">
                                Require approval
                              </p>
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                You approve each claim before the shift is
                                theirs.
                              </p>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={requiresApproval}
                              onClick={() =>
                                setValue(
                                  "requiresApproval",
                                  !requiresApproval,
                                  { shouldValidate: true },
                                )
                              }
                              className={cn(
                                "relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6] focus-visible:ring-offset-1 shrink-0",
                                requiresApproval
                                  ? "bg-[#1E3A5F]"
                                  : "bg-slate-200",
                              )}
                            >
                              <motion.span
                                layout
                                transition={{
                                  type: "spring",
                                  stiffness: 500,
                                  damping: 35,
                                }}
                                className={cn(
                                  "absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm",
                                  requiresApproval ? "left-6" : "left-1",
                                )}
                              />
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <Input
                      type="hidden"
                      name="openToClaims"
                      value={String(openToClaims)}
                    />
                    <Input
                      type="hidden"
                      name="requiresApproval"
                      value={String(requiresApproval)}
                    />
                  </div>

                  {/* Clock-in grace override */}
                  <div className="min-w-0 pt-6 border-t border-[#F1F5F9]">
                    <div className="max-w-xs min-w-0">
                      <Input
                        label="Clock-in grace period"
                        type="number"
                        min="0"
                        max="240"
                        placeholder="e.g. 30"
                        {...register("clockInGraceMinutes", {
                          valueAsNumber: true,
                        })}
                        className={cn(
                          errors.clockInGraceMinutes && "border-red-500!",
                        )}
                      />
                      <p className="text-[11px] text-slate-400 mt-1">
                        How early a worker can clock in. Leave blank to use your
                        company setting.
                      </p>
                      <FieldError
                        message={errors.clockInGraceMinutes?.message}
                      />
                    </div>
                  </div>

                  <div className="pt-6 border-t border-[#F1F5F9]" />

                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
                    Clock-in location check
                  </p>
                  <p className="text-[11px] text-slate-400 mb-3">
                    Overrides your company setting for this job only. Useful for
                    sites with poor signal, or where workers move around a large
                    area.
                  </p>

                  <div className="flex flex-col gap-2 min-w-0">
                    {[
                      {
                        value: "",
                        label: "Use company default",
                        sub: "Whatever's set in Settings — recommended",
                      },
                      {
                        value: "off",
                        label: "No location check",
                        sub: "Workers clock in from anywhere, nothing recorded",
                      },
                      {
                        value: "warn",
                        label: "Record and flag",
                        sub: "Always lets them clock in, but flags it if they're off site",
                      },
                      {
                        value: "enforce",
                        label: "Require them on site",
                        sub: "Blocks clock-in outside the radius — they'll need you to override it",
                      },
                    ].map((opt) => (
                      <label
                        key={opt.value}
                        className={cn(
                          "flex items-start gap-3 px-4 py-3 rounded-xl border-2 cursor-pointer transition-all min-w-0",
                          (geofenceMode ?? "") === opt.value
                            ? "border-[#1E3A5F] bg-[#1E3A5F]/[0.03]"
                            : "border-[#E2E8F0] hover:border-slate-300",
                        )}
                      >
                        <Input
                          type="radio"
                          className="sr-only"
                          checked={(geofenceMode ?? "") === opt.value}
                          onChange={() =>
                            setValue(
                              "geofenceMode",
                              opt.value === ""
                                ? undefined
                                : opt.value as "off" | "warn" | "enforce",
                              { shouldValidate: true },
                            )
                          }
                        />
                        <span
                          className={cn(
                            "mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
                            (geofenceMode ?? "") === opt.value
                              ? "border-[#1E3A5F] bg-[#1E3A5F]"
                              : "border-slate-300",
                          )}
                        >
                          {(geofenceMode ?? "") === opt.value && (
                            <span className="w-1.5 h-1.5 rounded-full bg-white" />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-slate-800">
                            {opt.label}
                          </span>
                          <span className="block text-[11px] text-slate-400 mt-0.5">
                            {opt.sub}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  <AnimatePresence initial={false}>
                    {geofenceMode && geofenceMode !== "off" && (
                      <motion.div
                        initial={{ opacity: 0, y: -6, height: 0 }}
                        animate={{ opacity: 1, y: 0, height: "auto" }}
                        exit={{ opacity: 0, y: -6, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="mt-4 max-w-xs min-w-0"
                      >
                        <Input
                          label="Radius"
                          type="number"
                          min="25"
                          max="5000"
                          step="25"
                          placeholder="150"
                          icon={<MapPin size={13} />}
                          {...register("geofenceRadiusMeters", {
                            valueAsNumber: true,
                          })}
                          className={cn(
                            errors.geofenceRadiusMeters && "border-red-500!",
                          )}
                        />
                        <p className="text-[11px] text-slate-400 mt-1">
                          Metres from the site. Phone GPS is often 50–100m out
                          indoors, so anything under 100m will flag people who
                          are genuinely there.
                        </p>
                        <FieldError
                          message={errors.geofenceRadiusMeters?.message}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {!coordinates && geofenceMode && geofenceMode !== "off" && (
                    <p className="mt-3 text-xs text-amber-600">
                      Pick a location above first — without map coordinates
                      there's nothing to measure against, so this won't do
                      anything.
                    </p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <CreateJobHiddenFields
          values={getValues()}
          clientId={selectedClient?._id}
          workers={selectedWorkers}
          recurring={recurring}
          generateInvoice={generateInvoice}
          invoiceDueDate={invoiceDueDate}
          invoiceLineItems={invoiceLineItems}
        />
        <button
          id="publish-job"
          hidden
          type="submit"
          name="status"
          value="published"
        />

        {/* Actions */}
        <div className="flex items-center gap-3 justify-end pt-2 pb-6">
          <Button
            type="button"
            variant="outline"
            onClick={() => onNavigate("/jobs")}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            name="status"
            value="draft"
            variant="secondary"
            disabled={isSubmitting || isFormSubmitting}
          >
            Save as Draft
          </Button>
          <Button
            type="button"
            onClick={publish}
            disabled={isSubmitting || isFormSubmitting}
          >
            {isFormSubmitting ? "Publishing…" : "Publish Job"}
          </Button>
        </div>
      </Form>
    </div>
  )
}
