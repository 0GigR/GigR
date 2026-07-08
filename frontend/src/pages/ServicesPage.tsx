import { useState, useEffect, useRef } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useGeolocation } from '@/hooks/useGeolocation'
import { useAuthStore } from '@/store/authStore'
import UserChip from '@/components/UserChip'
import {
  MapPin, Search, Plus, Edit, Trash2, RefreshCw, X, Send, ImagePlus, Loader2
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { NeighborhoodMap } from '@/components/NeighborhoodMap'
import { ImageViewer } from '@/components/ImageViewer'
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
    <Card className="bg-white border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        {provider && !isOwner && (
          <div className="mb-3">
            <UserChip
              userId={service.provider_id}
              name={provider.display_name}
              avatarUrl={provider.profile_image_url}
              lastSeenAt={(provider as any)?.last_seen_at}
            />
          </div>
        )}
        {service.image_url && (
          <div className="mb-3">
            <img
              src={service.image_url}
              className="rounded-lg w-full h-40 object-cover hover:opacity-90 transition-opacity cursor-pointer"
              onClick={() => window.dispatchEvent(new CustomEvent('open-lightbox', { detail: service.image_url }))}
            />
          </div>
        )}
        <div className="flex justify-between items-start">
          <CardTitle className="text-lg font-semibold">{service.title}</CardTitle>
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
          <span className="font-semibold text-black">₦{parseFloat(service.price as string).toLocaleString()}</span>
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
          <>
            {hasRequested && (
              <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full mr-auto">
                <Send className="w-3 h-3" /> Requested
              </span>
            )}
            <Button size="sm" variant="default" onClick={() => onRequest(service)} disabled={hasRequested || isRequesting} className="bg-black text-white hover:bg-gray-800 disabled:opacity-60">
              {isRequesting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
              {hasRequested ? 'Requested' : isRequesting ? 'Sending...' : 'Request'}
            </Button>
          </>
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

  useAuthStore() // we need user for checks, but we don't destructure to avoid unused warning
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
  const [activeTab, setActiveTab] = useState<'browse' | 'mine' | 'map'>('browse')
  const [sortOrder, setSortOrder] = useState('nearest') // nearest, newest, price_high, price_low
  const [radius, setRadius] = useState(10) // default 10km radius
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [requestingId, setRequestingId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const [formData, setFormData] = useState({
    category_id: '', title: '', description: '', price: '',
    latitude: 0, longitude: 0, radius_km: '5.0',
  })

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
  const nearbyServices = Array.isArray(nearbyPages?.pages) ? nearbyPages.pages.flat() : []

  // Reverse geocode
  useEffect(() => {
    if (latitude && longitude) {
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`)
        .then(res => res.json())
        .then(data => data?.display_name ? setAddress(data.display_name) : null)
        .catch(() => {})
    }
  }, [latitude, longitude])

  // Update location on backend
  useEffect(() => {
    if (latitude && longitude) {
      api.post('/users/me/location', { latitude, longitude }).catch(() => {})
    }
  }, [latitude, longitude])

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
      toast.success('Service created')
      setDialogOpen(false)
      resetForm()
    },
    onError: (err: any) => {
      if (err.response?.status === 409) {
        toast.error('You already have a service with this title')
      } else {
        toast.error(err.response?.data?.detail || 'Failed to create service')
      }
    },
  })

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string, data: ServiceUpdate }) => { const { data: res } = await api.patch(`/services/${id}`, data); return res },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myServices'] })
      queryClient.invalidateQueries({ queryKey: ['nearbyServices'] })
      toast.success('Service updated')
      setDialogOpen(false)
      resetForm()
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to update service'),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await api.delete(`/services/${id}`) },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myServices'] })
      queryClient.invalidateQueries({ queryKey: ['nearbyServices'] })
      toast.success('Service deleted')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to delete service'),
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
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to create category'),
  })

  const resetForm = () => {
    setFormData({ category_id: '', title: '', description: '', price: '', latitude: 0, longitude: 0, radius_km: '5.0' })
    setEditService(null)
    setImageFile(null)
    setImagePreview(null)
    setCatSearch('')
    setCatSearchResults([])
  }

  const handleCreateOrUpdate = async () => {
    if (isCreating) return
    if (!formData.title || !formData.price || !formData.category_id) { toast.error('Title, price, and category required'); return }
    if (!latitude || !longitude) { toast.error('Location not available'); return }

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
      let imageUrl: string | undefined
      if (imageFile) {
        try { imageUrl = await uploadFile(imageFile) } catch { setIsCreating(false); return }
      }

      const payload: ServiceCreate = {
        title: formData.title,
        description: formData.description,
        price: formData.price,
        category_id: formData.category_id,
        latitude,
        longitude,
        radius_km: formData.radius_km || '5.0',
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
      price: String(service.price),
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
      toast.error(err.response?.data?.detail || 'Failed to request service')
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
  const processedSearch = searchResults ? sortServices(searchResults) : null
  const processedMine = sortServices(myServices || [])

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Services & Neighborhood</h1>
          <p className="text-gray-500">{activeTab === 'browse' ? 'Discover services in your neighborhood' : activeTab === 'map' ? 'See activity around you' : 'Manage your offerings'}</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {activeTab === 'browse' && (
            <div className="flex items-center gap-2 mr-2 bg-white px-3 py-1 rounded-md border border-gray-200">
              <span className="text-sm text-gray-500 whitespace-nowrap">Radius: {radius}km</span>
              <input 
                type="range" 
                min="1" 
                max="50" 
                value={radius} 
                onChange={(e) => setRadius(parseInt(e.target.value))}
                className="w-24 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          )}
          {activeTab !== 'map' && (
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="w-[140px] bg-white border-gray-200">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nearest">Recommended</SelectItem>
                <SelectItem value="price_high">Price: High to Low</SelectItem>
                <SelectItem value="price_low">Price: Low to High</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button variant={activeTab === 'browse' ? 'default' : 'outline'} onClick={() => setActiveTab('browse')} className={activeTab === 'browse' ? 'bg-black text-white' : 'border-gray-200'}>
            <Search className="w-4 h-4 mr-2" /> Browse
          </Button>
          <Button variant={activeTab === 'map' ? 'default' : 'outline'} onClick={() => setActiveTab('map')} className={activeTab === 'map' ? 'bg-black text-white' : 'border-gray-200'}>
            <MapPin className="w-4 h-4 mr-2" /> Map
          </Button>
          <Button variant={activeTab === 'mine' ? 'default' : 'outline'} onClick={() => setActiveTab('mine')} className={activeTab === 'mine' ? 'bg-black text-white' : 'border-gray-200'}>
            My Services
          </Button>
          <Button variant="outline" onClick={handleNearbySearch} disabled={locLoading} className="border-gray-200" title="Refresh nearby search">
            <MapPin className="w-4 h-4 mr-2" /> Nearby
          </Button>
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm() }}>
            <DialogTrigger asChild>
              <Button className="bg-black text-white hover:bg-gray-800"><Plus className="w-4 h-4 mr-2" /> New</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg bg-white text-black max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>{editService ? 'Edit Service' : 'Create Service'}</DialogTitle></DialogHeader>
              <div className="space-y-4 py-4">
                <Input placeholder="Title *" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} />
                <Textarea placeholder="Description" value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} />
                <div className="grid grid-cols-2 gap-4">
                  <Input type="number" placeholder="Price (₦) *" value={formData.price} onChange={e => setFormData({...formData, price: e.target.value})} />
                  <div>
                    <div className="relative">
                      <Input type="number" min="0" step="0.5" placeholder="Radius" className="pr-10" value={formData.radius_km} onChange={e => setFormData({...formData, radius_km: e.target.value})} />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">km</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">Service radius</p>
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
                        <div className="absolute z-20 w-full bg-white border border-gray-200 rounded-lg mt-1 max-h-40 overflow-y-auto shadow-lg">
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
                        <div className="absolute z-20 w-full bg-white border border-gray-200 rounded-lg mt-1 p-2 shadow-lg">
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
                  <input type="file" accept="image/*" ref={fileRef} className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) {
                        setImageFile(file)
                        setImagePreview(URL.createObjectURL(file))
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
            <Input placeholder="Search services..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleTextSearch()} className="pl-10 bg-white border-gray-200" />
          </div>
          <Button variant="outline" onClick={handleTextSearch} disabled={searchLoading} className="border-gray-200">{searchLoading ? 'Searching...' : 'Search'}</Button>
          {searchResults && <Button variant="ghost" size="sm" onClick={clearSearch} className="text-gray-500"><X className="w-4 h-4 mr-1" /> Clear</Button>}
        </div>
      )}

      {/* Content based on active tab */}
      <AnimatePresence mode="wait">
        {activeTab === 'map' ? (
          <motion.div key="map" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {latitude && longitude ? (
              <NeighborhoodMap latitude={latitude} longitude={longitude} type="services" />
            ) : (
              <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
                <MapPin className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500">Enable location to view the neighborhood map.</p>
              </div>
            )}
          </motion.div>
        ) : searchResults ? (
          <motion.div key="search" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <h2 className="text-lg font-semibold mb-4">Search Results ({processedSearch!.length})</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {processedSearch!.map(s => <ServiceCard key={s.id} service={s} onEdit={handleEdit} onDelete={handleDelete} onRequest={handleRequest} hasRequested={requestedServiceIds.has(s.id)} isRequesting={requestingId === s.id} />)}
            </div>
          </motion.div>
        ) : activeTab === 'browse' ? (
          <motion.div key="browse" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
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
                  <div className="flex justify-center mt-6">
                    <Button
                      variant="outline"
                      onClick={() => fetchMoreNearby()}
                      disabled={loadingMoreNearby}
                      className="px-8"
                    >
                      {loadingMoreNearby ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                      {loadingMoreNearby ? 'Loading...' : 'Load More Services'}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 border border-dashed border-gray-200 rounded-xl bg-gray-50">
                <MapPin className="w-10 h-10 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500">No services found nearby. Try a wider search or create your own.</p>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div key="mine" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <h2 className="text-lg font-semibold mb-4">My Services</h2>
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
          </motion.div>
        )}
      </AnimatePresence>

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