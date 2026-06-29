import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { Mail, Phone, Star, Briefcase, Calendar } from 'lucide-react'
import type { components } from '@/types/api'

type UserProfile = components['schemas']['UserOut']
type Vouch = components['schemas']['VouchOut']
type Service = components['schemas']['ServiceOut']

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>()

  const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ['user', userId],
    queryFn: async () => { const { data } = await api.get(`/users/${userId}`); return data },
    enabled: !!userId,
  })

  const { data: vouches } = useQuery<Vouch[]>({
    queryKey: ['vouches', userId],
    queryFn: async () => { const { data } = await api.get(`/vouches/user/${userId}`); return data },
    enabled: !!userId,
  })

  const { data: services } = useQuery<Service[]>({
    queryKey: ['services', userId],
    queryFn: async () => { const { data } = await api.get(`/services/provider/${userId}`); return data },
    enabled: !!userId,
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (!profile) return <div className="text-center py-12 text-gray-500">User not found.</div>

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-4xl">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile.profile_image_url || undefined} />
              <AvatarFallback className="text-2xl bg-black text-white">{profile.display_name?.[0]?.toUpperCase() || '?'}</AvatarFallback>
            </Avatar>
            <div>
              <CardTitle className="text-2xl">{profile.display_name}</CardTitle>
              <div className="flex items-center gap-2 text-sm text-gray-500 mt-1"><Mail className="w-4 h-4" /> {profile.email}</div>
              {profile.phone_number && <div className="flex items-center gap-2 text-sm text-gray-500 mt-1"><Phone className="w-4 h-4" /> {profile.phone_number}</div>}
              <div className="flex items-center gap-2 text-sm text-gray-500 mt-1"><Calendar className="w-4 h-4" /> Joined {new Date(profile.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div><p className="text-2xl font-bold">{vouches?.length || 0}</p><p className="text-xs text-gray-500">Vouches</p></div>
            <div><p className="text-2xl font-bold">{services?.length || 0}</p><p className="text-xs text-gray-500">Services</p></div>
            <div><p className="text-2xl font-bold">{profile.is_verified ? 'Yes' : 'No'}</p><p className="text-xs text-gray-500">Verified</p></div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-lg"><Star className="w-5 h-5 inline mr-2" />Vouch History ({vouches?.length || 0})</CardTitle></CardHeader>
        <CardContent>
          {vouches?.length ? vouches.map(v => (
            <div key={v.id} className="flex justify-between bg-gray-50 rounded-lg p-3 mb-2">
              <div><p className="text-sm font-medium">Job: {v.job_id?.slice(0, 8)}...</p><p className="text-xs text-gray-500">cNFT: {v.cnf_nft_id?.slice(0, 12)}...</p></div>
              <span className="text-xs text-gray-400">{new Date(v.created_at).toLocaleDateString()}</span>
            </div>
          )) : <p className="text-sm text-gray-500">No vouches yet.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-lg"><Briefcase className="w-5 h-5 inline mr-2" />Services ({services?.length || 0})</CardTitle></CardHeader>
        <CardContent>
          {services?.length ? <div className="grid gap-4 md:grid-cols-2">{services.map(s => <Card key={s.id} className="bg-gray-50"><CardHeader className="pb-2"><CardTitle className="text-base">{s.title}</CardTitle></CardHeader><CardContent className="text-sm"><p>₦{parseFloat(s.price as string).toLocaleString()}</p></CardContent></Card>)}</div> : <p className="text-sm text-gray-500">No services.</p>}
        </CardContent>
      </Card>
    </div>
  )
}