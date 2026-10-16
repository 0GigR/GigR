import { fmtPrice } from '@/store/currencyStore'
import { useState, useEffect, useRef } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api, { extractError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PriceInput } from '@/components/PriceInput'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useGeolocation } from '@/hooks/useGeolocation'
import { useAuthStore } from '@/store/authStore'
import { useRadiusStore } from '@/store/radiusStore'
import UserChip from '@/components/UserChip'
import { Link, useSearchParams } from 'react-router-dom'
import {
  MapPin, Search, Plus, Edit, Trash2, RefreshCw, X, Send, ImagePlus, Loader2, BadgeCheck, Wrench
} from 'lucide-react'
import { MapExplorer } from '@/components/map/MapExplorer'
import { ImageViewer } from '@/components/ImageViewer'
import { LocationPicker } from '@/components/LocationPicker'
import { useInView } from 'react-intersection-observer'
import { processImageFile } from '@/lib/imageUtils'
import type { components } from '@/types/api'

// ---------- Types ----------
type Service = components['schemas']['ServiceOut']
type Category = components['schemas']['CategoryOut']
type ServiceCreate = components['schemas']['ServiceCreate']
type ServiceUpdate = components['schemas']['ServiceUpdate']
type UserProfile = components['schemas']['UserOut']

// ---------- Helper: fetch user by ID ----------
function useUserInfo(userId: string | undefined) {
  return useQuery<UserProfile>({
    queryKey: ['user', userId],
    queryFn: async () => {
      const { data } = await api.get(`/users/${userId}`)
      return data
    },
    enabled: !!userId,
  })
}

// ---------- Cloudinary upload ----------
async function uploadFile(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', preset)
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json()
    toast.error('Image upload failed: ' + (err.error?.message || ''))
    throw new Error(err.error?.message || 'Upload failed')
  }
  const data = await res.json()
  toast.success('Image uploaded')
  return data.secure_url
}

// ---------- Service Card with provider info ----------
function ServiceCard({ service, onEdit, onDelete, onRequest, hasRequested, isRequesting }: {
  service: Service
  onEdit: (s: Service) => void
  onDelete: (s: Service) => void
  onRequest: (s: Service) => void
  hasRequested?: boolean
  isRequesting?: boolean
}) {
  const { user } = useAuthStore()
  const isOwner = user?.id === service.provider_id
  const { data: provider } = useUserInfo(service.provider_id)
  const [showFullDesc, setShowFullDesc] = useState(false)

  return (
    <Card className="bg-card text-card-foreground border-border shadow-sm hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        {provider && !isOwner && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <UserChip
              userId={service.provider_id}
              name={provider.display_name}
              avatarUrl={provider.profile_image_url}
              lastSeenAt={(provider as any)?.last_seen_at}
            />
            {!!(provider as any)?.vouches_received_count && (provider as any).vouches_received_count > 0 && (
              <span className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full font-medium">
                <BadgeCheck className="w-3 h-3" />
                {(provider as any).vouches_received_count} vouch{(provider as any).vouches_received_count !== 1 ? 'es' : ''}
              </span>
            )}
          </div>
        )}
        {service.image_url && (
          <div className="mb-3 block group cursor-pointer" onClick={() => window.dispatchEvent(new CustomEvent('open-lightbox', { detail: service.image_url }))}>
            <img
              src={service.image_url}
              className="rounded-lg w-full h-40 object-cover group-hover:opacity-90 transition-opacity"
            />
          </div>
        )}
        <div className="flex justify-between items-start">
          <Link to={`/dashboard/services/${service.id}`} className="hover:underline decoration-2 underline-offset-2">
            <CardTitle className="text-lg font-semibold">{service.title}</CardTitle>
          </Link>
          <Badge variant={service.is_active ? 'default' : 'secondary'} className={service.is_active ? 'bg-black text-white' : 'bg-gray-200 text-gray-600'}>
            {service.is_active ? 'Active' : 'Paused'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-gray-600">
        <div>
          <p className={`mb-1 ${!showFullDesc ? 'line-clamp-2' : ''}`}>{service.description}</p>
          {service.description && service.description.length > 100 && (
            <button className="text-xs text-blue-600 hover:underline" onClick={() => setShowFullDesc(!showFullDesc)}>
              {showFullDesc ? 'See less' : 'See more'}
            </button>
          )}
        </div>
        <div className="flex justify-between items-center mt-2">
          <span className="font-semibold text-black dark:text-white">
            {(() => {
              const p = service.price != null ? parseFloat(service.price as string) : null
              const minP = service.min_price != null ? parseFloat(service.min_price as string) : null
              const maxP = service.max_price != null ? parseFloat(service.max_price as string) : null
              if (p && p > 0) return fmtPrice(p)
              if (minP && maxP && minP > 0 && maxP > 0) return `${fmtPrice(minP)} – ${fmtPrice(maxP)}`
              if (minP && minP > 0) return `From ${fmtPrice(minP)}`
              if (maxP && maxP > 0) return `Up to ${fmtPrice(maxP)}`
              return 'Negotiable'
            })()}
          </span>
          <span className="text-gray-400 text-xs">{service.radius_km} km radius</span>
        </div>
      </CardContent>
      <CardFooter className="pt-4 flex gap-2 justify-end items-center">
        {isOwner ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => onEdit(service)} className="text-gray-600 hover:text-black">
              <Edit className="w-4 h-4 mr-1" /> Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDelete(service)} className="text-gray-600 hover:text-red-600">
              <Trash2 className="w-4 h-4 mr-1" /> Delete
            </Button>
          </>
        ) : (
          <div className="flex w-full justify-between items-center">
            <Link to={`/dashboard/services/${service.id}`} className="text-sm font-medium text-blue-600 hover:underline">
              View details →
            </Link>
            <div className="flex items-center gap-2">
              {hasRequested && (
                <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
                  <Send className="w-3 h-3" /> Requested
                </span>
              )}
              <Button size="sm" variant="default" onClick={() => onRequest(service)} disabled={hasRequested || isRequesting} className="bg-black text-white hover:bg-gray-800 disabled:opacity-60">
                {isRequesting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                {hasRequested ? 'Requested' : isRequesting ? 'Sending...' : 'Request'}
              </Button>
            </div>
          </div>
        )}
      </CardFooter>
    </Card>
  )
}

// ---------- Main Page ----------
export default function ServicesPage() {
  const queryClient = useQueryClient()
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  useEffect(() => {
    const handleOpenLightbox = (e: Event) => {
      const url = (e as CustomEvent).detail
      setLightboxSrc(url)
    }
    window.addEventListener('open-lightbox', handleOpenLightbox)
    return () => window.removeEventListener('open-lightbox', handleOpenLightbox)
  }, [])

  const { user: currentUser } = useAuthStore()
  const { latitude, longitude, loading: locLoading, error: locError, refresh: refreshLoc } = useGeolocation()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<Service[] | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editService, setEditService] = useState<Service | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [catSearch, setCatSearch] = useState('')
  const [catSearchResults, setCatSearchResults] = useState<Category[]>([])
  const [searchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<'browse' | 'mine' | 'map'>(
    tabParam === 'map' ? 'map' : tabParam === 'mine' ? 'mine' : 'browse'
  )

  useEffect(() => {
    const requestedTab = searchParams.get('tab')
    if (requestedTab === 'map' || requestedTab === 'mine' || requestedTab === 'browse') {
      setActiveTab(requestedTab)
    }
  }, [searchParams])
  const [sortOrder, setSortOrder] = useState('nearest') // nearest, newest, price_high, price_low
  // Search radius connected to global radiusStore.
  const { radiusKm: radius, setRadiusKm: setRadius } = useRadiusStore()
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [requestingId, setRequestingId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [useCustomLocation, setUseCustomLocation] = useState(false)
  const [customLocation, setCustomLocation] = useState<{lat: number, lng: number} | null>(null)
  
  const [formData, setFormData] = useState({
    category_id: '', title: '', description: '', price: '',
    min_price: '', max_price: '',
    latitude: 0, longitude: 0, radius_km: '5.0',
  })

  useEffect(() => {
    const draft = localStorage.getItem('serviceFormDraft')
    if (draft) {
      try { setFormData(JSON.parse(draft)) } catch {}
    }
  }, [])

  useEffect(() => {
    if (formData.title || formData.description || formData.price) {
      const timeout = setTimeout(() => {
        localStorage.setItem('serviceFormDraft', JSON.stringify(formData))
      }, 1000)
      return () => clearTimeout(timeout)
    }
  }, [formData])

  // Fetch categories (not used directly in UI, but needed for seeding)
  useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: async () => { const { data } = await api.get('/categories/'); return data },
  })

  // Fetch my services (for checking duplicates)
  const { data: myServices, isLoading: myLoading } = useQuery<Service[]>({
    queryKey: ['myServices'],
    queryFn: async () => { const { data } = await api.get('/services/'); return data },
  })

  // Services the user has already requested (for the "Requested" indicator)
  const { data: myClientJobs } = useQuery<any[]>({
    queryKey: ['myClientJobs'],
    queryFn: async () => { const { data } = await api.get('/jobs/', { params: { my: 'client' } }); return data },
  })
  // const requestedServiceIds = new Set(
  //   (myClientJobs || []).map((j) => j.service_listing_id).filter(Boolean)
  // )

  const requestedServiceIds = new Set(
    (myClientJobs || [])
      .filter(j => !['completed', 'cancelled'].includes(j.status))
      .map((j) => j.service_listing_id)
      .filter(Boolean)
  )

  const SVC_PAGE_SIZE = 20
  const {
    data: nearbyPages,
    isLoading: nearbyLoading,
    fetchNextPage: fetchMoreNearby,
    hasNextPage: hasMoreNearby,
    isFetchingNextPage: loadingMoreNearby,
  } = useInfiniteQuery<Service[]>({
    queryKey: ['nearbyServices', latitude, longitude, radius],
    queryFn: async ({ pageParam = 0 }) => {
      if (!latitude || !longitude) return []
      const { data } = await api.get('/services/search/nearby', { params: { lat: latitude, lon: longitude, radius, limit: SVC_PAGE_SIZE, offset: pageParam } })
      return Array.isArray(data) ? data : []
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < SVC_PAGE_SIZE) return undefined
      return allPages.flat().length
    },
    enabled: !!latitude && !!longitude,
  })

  const { ref: loadMoreRef, inView } = useInView()
  useEffect(() => {
    if (inView && hasMoreNearby && !loadingMoreNearby) {
      fetchMoreNearby()
    }
  }, [inView, hasMoreNearby, loadingMoreNearby, fetchMoreNearby])
  // Exclude the viewer's own services from the public browse list
  const nearbyServices = (Array.isArray(nearbyPages?.pages) ? nearbyPages.pages.flat() : [])
    .filter((s) => s.provider_id !== currentUser?.id)

  // Reverse geocode
  useEffect(() => {
    if (latitude && longitude) {
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`)
        .then(res => res.json())
        .then(data => data?.display_name ? setAddress(data.display_name) : null)
        .catch(() => {})
    }
  }, [latitude, longitude])

  // Location is requested and synced once by locationStore (via useGeolocation).
  // The POST that used to live here was a duplicate of three others.

  // Search handlers
  const handleTextSearch = async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return }
    setSearchLoading(true)
    try {
      const { data } = await api.get('/services/search/text', { params: { q: searchQuery } })
      setSearchResults(data)
      setActiveTab('browse')
    } catch { toast.error('Search failed') }
    finally { setSearchLoading(false) }
  }

  const handleNearbySearch = async () => {
    if (!latitude || !longitude) { toast.error('Location not available'); return }
    setSearchLoading(true)
    try {
      const { data } = await api.get('/services/search/nearby', { params: { lat: latitude, lon: longitude, radius: 10 } })
      setSearchResults(data)
      setActiveTab('browse')
    } catch { toast.error('Search failed') }
    finally { setSearchLoading(false) }
  }

  const clearSearch = () => { setSearchResults(null); setSearchQuery('') }

  // Mutations
  const createMutation = useMutation({
    mutationFn: async (data: ServiceCreate) => { const { data: res } = await api.post('/services/', data); return res },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myServices'] })
      queryClient.invalidateQueries({ queryKey: ['nearbyServices'] })
      queryClient.invalidateQueries({ queryKey: ['map-nearby-services'] })
      toast.success('Service created')
      setDialogOpen(false)
      resetForm()
      localStorage.removeItem('serviceFormDraft')
    },
    onError: (err: any) => {
      if (err.response?.status === 409) {
        toast.error('You already have a service with this title')
      } else {
        toast.error(extractError(err, 'Failed to create service'))
      }
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string, data: ServiceUpdate }) => { const { data: res } = await api.patch(`/services/${id}`, data); return res },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myServices'] })
      queryClient.invalidateQueries({ queryKey: ['nearbyServices'] })
      queryClient.invalidateQueries({ queryKey: ['map-nearby-services'] })
      toast.success('Service updated')
      setDialogOpen(false)
      resetForm()
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to update service')),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/services/${id}`) },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myServices'] })
      queryClient.invalidateQueries({ queryKey: ['nearbyServices'] })
      queryClient.invalidateQueries({ queryKey: ['map-nearby-services'] })
      toast.success('Service deleted')
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to delete service')),
  })

  const createCategoryMutation = useMutation({
    mutationFn: async (name: string) => { const { data } = await api.post('/categories/', { name }); return data as Category },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      setFormData(p => ({ ...p, category_id: data.id }))
      setCatSearch(data.name)
      setCatSearchResults([])
      toast.success('Category created')
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to create category')),
  })

  const resetForm = () => {
    const initialRadius = radius > 0 ? String(radius) : '10.0'
    setFormData({ category_id: '', title: '', description: '', price: '', min_price: '', max_price: '', latitude: 0, longitude: 0, radius_km: initialRadius })
    setEditService(null)
    setImageFile(null)
    setImagePreview(null)
    setCatSearch('')
    setCatSearchResults([])
  }

  const handleCreateOrUpdate = async () => {
    if (isCreating) return
    if (!formData.category_id || !formData.title) return toast.error('Category and title are required')
    const finalLat = useCustomLocation && customLocation ? customLocation.lat : (formData.latitude || latitude)
    const finalLng = useCustomLocation && customLocation ? customLocation.lng : (formData.longitude || longitude)
    if (!finalLat || !finalLng) return toast.error('Location is required')

    // Duplicate check
    if (!editService && myServices) {
      const exists = myServices.some(s => s.title.toLowerCase() === formData.title.toLowerCase())
      if (exists) {
        toast.error('You already have a service with this title')
        return
      }
    }

    setIsCreating(true)
    try {
      let imageUrl = editService?.image_url || null
      if (imageFile) {
        try { imageUrl = await uploadFile(imageFile) } catch { return }
      }

      const payload: any = {
        category_id: formData.category_id,
        title: formData.title,
        description: formData.description || undefined,
        price: formData.price ? parseFloat(formData.price) : undefined,
        min_price: formData.min_price ? parseFloat(formData.min_price) : undefined,
        max_price: formData.max_price ? parseFloat(formData.max_price) : undefined,
        latitude: finalLat,
        longitude: finalLng,
        radius_km: formData.radius_km,
        image_url: imageUrl,
      }

      if (editService) {
        updateMutation.mutate({ id: editService.id, data: payload })
      } else {
        createMutation.mutate(payload)
      }
    } finally {
      setIsCreating(false)
    }
  }

  const handleEdit = (service: Service) => {
    setEditService(service)
    setFormData({
      category_id: service.category_id,
      title: service.title,
      description: service.description || '',
      price: service.price ? String(service.price) : '',
      min_price: service.min_price ? String(service.min_price) : '',
      max_price: service.max_price ? String(service.max_price) : '',
      latitude: service.latitude,
      longitude: service.longitude,
      radius_km: String(service.radius_km),
    })
    setCatSearch('') // clear category search
    setDialogOpen(true)
  }

  const handleDelete = (service: Service) => setDeleteTarget(service)
  // const handleRequest = (service: Service) => toast.success(`Request sent for "${service.title}"`)
  const handleRequest = async (service: Service) => {
    // Guard against double-clicks creating duplicate requests/jobs
    if (requestingId) return
    setRequestingId(service.id)
    try {
      await api.post(`/jobs/request-service/${service.id}`)
      queryClient.invalidateQueries({ queryKey: ['myClientJobs'] })
      toast.success(`Request sent! View it in My Jobs.`)
    } catch (err: any) {
      toast.error(extractError(err, 'Failed to request service'))
    } finally {
      setRequestingId(null)
    }
  }

  // Sorting helper
  const sortServices = (services: Service[]) => {
    if (!Array.isArray(services)) return []
    const arr = [...services]
    if (sortOrder === 'price_high') arr.sort((a, b) => parseFloat(b.price as string) - parseFloat(a.price as string))
    if (sortOrder === 'price_low') arr.sort((a, b) => parseFloat(a.price as string) - parseFloat(b.price as string))
    // we don't have created_at readily on service model right now, so nearest/newest defaults to backend order if not price
    return arr
  }

  const processedNearby = sortServices(nearbyServices)
  const processedSearch = searchResults
    ? sortServices(searchResults.filter((s) => s.provider_id !== currentUser?.id))
    : null
  const processedMine = sortServices(myServices || [])

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      {/* One segmented switcher instead of three same-weight buttons competing
          with the primary action. */}
      {/* Pinned while scrolling: on a long list the view switcher used to scroll
          away, so you had to go back to the top to change view. */}
      <div className="sticky top-14 z-30 -mx-4 px-4 py-2 bg-white/90 dark:bg-gray-950/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
      <div className="inline-flex rounded-xl border border-gray-200 dark:border-gray-800 p-0.5 bg-gray-50 dark:bg-gray-900">
        {([
          ['browse', 'Browse', Search],
          ['map', 'Map', MapPin],
          ['mine', 'My Services', Wrench],
        ] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            onClick={() => setActiveTab(value)}
            aria-pressed={activeTab === value}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              activeTab === value
                ? 'bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm'
                : 'text-gray-500 hover:text-black dark:hover:text-white'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Services</h1>
          <p className="text-gray-500">{activeTab === 'browse' ? 'Discover services in your neighborhood' : activeTab === 'map' ? 'See activity around you' : 'Manage your offerings'}</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {activeTab !== 'map' && (
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[140px] bg-background border-border">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nearest">Recommended</SelectItem>
                <SelectItem value="price_high">Price: High to Low</SelectItem>
                <SelectItem value="price_low">Price: Low to High</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" onClick={handleNearbySearch} disabled={locLoading} className="border-gray-200" title="Refresh nearby search">
            <MapPin className="w-4 h-4" />
            <span className="sr-only">Refresh nearby search</span>
          </Button>
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm() }}>
            <DialogTrigger asChild>
              <Button className="gigr-cta border-0"><Plus className="w-4 h-4 mr-2" /> New</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg bg-background text-foreground max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>{editService ? 'Edit Service' : 'Create Service'}</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <Input placeholder="Title *" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} />
                <Textarea placeholder="Description" value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} />
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-4">
                    <PriceInput placeholder="Fixed Rate (Optional)" value={formData.price} onChange={v => setFormData({...formData, price: v})} />
                    <div>
                      <div className="relative">
                        <Input type="number" min="0" step="0.5" placeholder="Radius" className="pr-10" value={formData.radius_km} onChange={e => setFormData({...formData, radius_km: e.target.value})} />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">km</span>
                      </div>
                      <p className="text-xs text-gray-400 mt-1">Service radius</p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1.5">Or set a flexible price range:</p>
                    <div className="grid grid-cols-2 gap-3">
                      <PriceInput placeholder="Min Price (Optional)" value={formData.min_price} onChange={v => setFormData({...formData, min_price: v})} />
                      <PriceInput placeholder="Max Price (Optional)" value={formData.max_price} onChange={v => setFormData({...formData, max_price: v})} />
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">Transparent prices are prioritized in search and by the AI agent.</p>
                  </div>
                </div>

                {/* Category search & create */}
                <div>
                  <label className="text-sm font-medium text-gray-700">Category *</label>
                  {!formData.category_id ? (
                    <div className="relative">
                      <Input placeholder="Search or type a new category..." value={catSearch}
                        onChange={(e) => {
                          const val = e.target.value
                          setCatSearch(val)
                          if (val.trim()) {
                            api.get('/categories/', { params: { q: val } }).then(({ data }) => setCatSearchResults(data as Category[])).catch(() => setCatSearchResults([]))
                          } else {
                            setCatSearchResults([])
                          }
                        }}
                      />
                      {catSearch && catSearchResults.length > 0 && (
                        <div className="absolute z-20 w-full bg-background border border-border rounded-lg mt-1 max-h-40 overflow-y-auto shadow-lg">
                          {catSearchResults.map(cat => (
                            <div key={cat.id} className="px-4 py-2 hover:bg-gray-100 cursor-pointer text-sm" onClick={() => {
                              setFormData({...formData, category_id: cat.id})
                              setCatSearch(cat.name)
                              setCatSearchResults([])
                            }}>
                              {cat.name}
                            </div>
                          ))}
                        </div>
                      )}
                      {catSearch && catSearchResults.length === 0 && (
                        <div className="absolute z-20 w-full bg-background border border-border rounded-lg mt-1 p-2 shadow-lg">
                          <p className="text-sm text-gray-500 mb-2">No matches. Create "{catSearch}"</p>
                          <Button size="sm" onClick={() => createCategoryMutation.mutate(catSearch.trim())} disabled={!catSearch.trim()} className="w-full bg-black text-white">
                            <Plus className="w-4 h-4 mr-1" /> Create "{catSearch}"
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-sm bg-gray-100 px-3 py-1 rounded-full">{catSearch}</span>
                      <Button size="sm" variant="ghost" onClick={() => { setFormData({...formData, category_id: ''}); setCatSearch('') }}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>

                {/* Image upload */}
                <div>
                  <input type="file" accept="image/*, .heic, .heif, .webp" ref={fileRef} className="hidden"
                    onChange={async e => {
                      const file = e.target.files?.[0]
                      if (file) {
                        const processed = await processImageFile(file)
                        setImageFile(processed)
                        setImagePreview(URL.createObjectURL(processed))
                      }
                    }}
                  />
                  {imagePreview ? (
                    <div className="relative w-32 h-32">
                      <img src={imagePreview} className="rounded-lg object-cover w-full h-full" />
                      <X className="absolute top-1 right-1 h-4 w-4 bg-white rounded-full cursor-pointer" onClick={() => { setImageFile(null); setImagePreview(null) }} />
                    </div>
                  ) : (
                    <Button variant="outline" onClick={() => fileRef.current?.click()} className="w-full">
                      <ImagePlus className="w-4 h-4 mr-2" /> Add Photo (optional)
                    </Button>
                  )}
                </div>

                {/* Location */}
                <div className="text-sm text-gray-500">
                  {locLoading ? 'Getting location...' : locError ? (
                    <span className="text-red-500 flex items-center gap-1"><X className="w-3 h-3 inline" />{locError} <Button size="sm" variant="ghost" onClick={refreshLoc}><RefreshCw className="w-3 h-3" /></Button></span>
                  ) : address ? (
                    <span className="flex items-center gap-1"><MapPin className="w-4 h-4 inline text-gray-500" /> {address}</span>
                  ) : `Lat: ${latitude?.toFixed(4)}, Lon: ${longitude?.toFixed(4)}`}
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <input 
                    type="checkbox" 
                    id="custom-location-service" 
                    checked={useCustomLocation} 
                    onChange={(e) => {
                      setUseCustomLocation(e.target.checked)
                      if (e.target.checked && !customLocation && (formData.latitude || latitude) && (formData.longitude || longitude)) {
                        setCustomLocation({ lat: formData.latitude || latitude!, lng: formData.longitude || longitude! })
                      }
                    }} 
                  />
                  <label htmlFor="custom-location-service" className="text-sm font-medium">Use custom location (instead of current GPS)</label>
                </div>
                {useCustomLocation && customLocation && (
                  <div className="mt-2">
                    <LocationPicker 
                      latitude={customLocation.lat} 
                      longitude={customLocation.lng} 
                      onChange={(lat, lng) => setCustomLocation({ lat, lng })} 
                    />
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setDialogOpen(false)} className="border-gray-200">Cancel</Button>
                  <Button onClick={handleCreateOrUpdate} className="bg-black text-white hover:bg-gray-800" disabled={locLoading || isCreating || createMutation.isPending || updateMutation.isPending}>
                    {isCreating || createMutation.isPending || updateMutation.isPending
                      ? (editService ? 'Saving...' : 'Creating...')
                      : (editService ? 'Save Changes' : 'Create')}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Search bar (only for browse) */}
      {activeTab === 'browse' && (
        <div className="flex gap-2 items-center">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
            <Input placeholder="Search services..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleTextSearch()} className="pl-10 bg-background border-border" />
          </div>
          <Button variant="outline" onClick={handleTextSearch} disabled={searchLoading} className="border-gray-200">{searchLoading ? 'Searching...' : 'Search'}</Button>
          {searchResults && <Button variant="ghost" size="sm" onClick={clearSearch} className="text-gray-500"><X className="w-4 h-4 mr-1" /> Clear</Button>}
        </div>
      )}

      {/* Content based on active tab */}
      {/* No exit animation around the map: Leaflet must unmount cleanly. */}
      <>
        {activeTab === 'map' ? (
          <div key="map" className="animate-in fade-in duration-200">
            {latitude && longitude ? (
              <MapExplorer
                latitude={latitude}
                longitude={longitude}
                type="services"
                radiusKm={radius}
                onRadiusChange={setRadius}
              />
            ) : (
              <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
                <MapPin className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500">Enable location to view the neighborhood map.</p>
              </div>
            )}
          </div>
        ) : searchResults ? (
          <div key="search" className="animate-in fade-in duration-200">
            <h2 className="text-lg font-semibold mb-4">Search Results ({processedSearch!.length})</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {processedSearch!.map(s => <ServiceCard key={s.id} service={s} onEdit={handleEdit} onDelete={handleDelete} onRequest={handleRequest} hasRequested={requestedServiceIds.has(s.id)} isRequesting={requestingId === s.id} />)}
            </div>
          </div>
        ) : activeTab === 'browse' ? (
          <div key="browse" className="animate-in fade-in duration-200">
            <h2 className="text-lg font-semibold mb-4">Browse Services</h2>
            {nearbyLoading ? (
              <div className="grid gap-4 md:grid-cols-2">
                {[1,2,3,4].map(i => <Card key={i} className="bg-gray-50"><CardHeader><Skeleton className="h-5 w-3/4" /></CardHeader><CardContent><Skeleton className="h-4 w-full mb-2" /><Skeleton className="h-4 w-1/2" /></CardContent></Card>)}
              </div>
            ) : processedNearby.length ? (
              <>
                <div className="grid gap-4 md:grid-cols-2">
                  {processedNearby.map(s => <ServiceCard key={s.id} service={s} onEdit={handleEdit} onDelete={handleDelete} onRequest={handleRequest} hasRequested={requestedServiceIds.has(s.id)} isRequesting={requestingId === s.id} />)}
                </div>
                {hasMoreNearby && (
                  <div ref={loadMoreRef} className="flex justify-center mt-6 py-4">
                    {loadingMoreNearby ? (
                      <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                    ) : (
                      <div className="w-6 h-6" /> // spacer
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
                <MapPin className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500">No services found nearby. Try a wider search or create your own.</p>
              </div>
            )}
          </div>
        ) : (
          <div key="mine" className="animate-in fade-in duration-200">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
              <h2 className="text-lg font-semibold">My Services</h2>
              {processedMine.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const currentRadius = radius > 0 ? radius : 25
                    try {
                      await api.post('/services/my-services/sync-radius', { radius_km: currentRadius })
                      queryClient.invalidateQueries({ queryKey: ['myServices'] })
                      toast.success(`Updated all active services to ${currentRadius} km coverage radius`)
                    } catch (err: any) {
                      toast.error(extractError(err, 'Failed to sync service radius'))
                    }
                  }}
                  className="text-xs h-8 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                  Sync all services to current radius ({radius > 0 ? `${radius} km` : '25 km'})
                </Button>
              )}
            </div>
            {myLoading ? (
              <div className="grid gap-4 md:grid-cols-2">
                {[1,2].map(i => <Card key={i} className="bg-gray-50"><CardHeader><Skeleton className="h-5 w-3/4" /></CardHeader><CardContent><Skeleton className="h-4 w-full mb-2" /><Skeleton className="h-4 w-1/2" /></CardContent></Card>)}
              </div>
            ) : processedMine.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {processedMine.map(s => <ServiceCard key={s.id} service={s} onEdit={handleEdit} onDelete={handleDelete} onRequest={handleRequest} hasRequested={requestedServiceIds.has(s.id)} isRequesting={requestingId === s.id} />)}
              </div>
            ) : (
              <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
                <Plus className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500">You haven't created any services yet.</p>
              </div>
            )}
          </div>
        )}
      </>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Delete service?"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null) } }}
      />
      {lightboxSrc && (
        <ImageViewer open={!!lightboxSrc} onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
      )}
    </div>
  )
}