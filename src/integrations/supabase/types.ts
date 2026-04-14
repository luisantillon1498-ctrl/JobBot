export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

/** Matches public.application_events.event_type CHECK constraint */
export type ApplicationEventType =
  | "status_change"
  | "note"
  | "interview_scheduled"
  | "document_generated"
  | "follow_up"
  | "outcome_change"

/** Matches public.documents.type CHECK constraint */
export type DocumentType = "resume" | "cover_letter_template" | "other"

/** Matches app pipelines (no DB CHECK on column after status refactor) */
export type ApplicationStatus =
  | "draft"
  | "applied"
  | "screening"
  | "first_round_interview"
  | "second_round_interview"
  | "final_round_interview"

/** Matches UI outcomes (outcome is nullable text in DB) */
export type ApplicationOutcome = "rejected" | "withdrew" | "offer_accepted" | "ghosted"

/** Matches public.generated_artifacts.type CHECK constraint */
export type GeneratedArtifactType =
  | "cover_letter"
  | "tailored_resume"
  | "follow_up_email"
  | "thank_you_note"

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      application_documents: {
        Row: {
          application_id: string
          created_at: string
          document_id: string
          id: string
          user_id: string
        }
        Insert: {
          application_id: string
          created_at?: string
          document_id: string
          id?: string
          user_id: string
        }
        Update: {
          application_id?: string
          created_at?: string
          document_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_documents_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_documents_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      application_events: {
        Row: {
          application_id: string
          created_at: string
          description: string
          event_type: ApplicationEventType
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          application_id: string
          created_at?: string
          description: string
          event_type: ApplicationEventType
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          application_id?: string
          created_at?: string
          description?: string
          event_type?: ApplicationEventType
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_events_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      applications: {
        Row: {
          application_status: ApplicationStatus
          applied_at: string | null
          company_name: string
          created_at: string
          id: string
          job_description: string | null
          job_title: string
          job_url: string | null
          location: string | null
          notes: string | null
          outcome: ApplicationOutcome | null
          salary_range: string | null
          submitted_cover_document_id: string | null
          submitted_resume_document_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          application_status?: ApplicationStatus
          applied_at?: string | null
          company_name: string
          created_at?: string
          id?: string
          job_description?: string | null
          job_title: string
          job_url?: string | null
          location?: string | null
          notes?: string | null
          outcome?: ApplicationOutcome | null
          salary_range?: string | null
          submitted_cover_document_id?: string | null
          submitted_resume_document_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          application_status?: ApplicationStatus
          applied_at?: string | null
          company_name?: string
          created_at?: string
          id?: string
          job_description?: string | null
          job_title?: string
          job_url?: string | null
          location?: string | null
          notes?: string | null
          outcome?: ApplicationOutcome | null
          salary_range?: string | null
          submitted_cover_document_id?: string | null
          submitted_resume_document_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      documents: {
        Row: {
          created_at: string
          file_path: string
          file_size: number | null
          id: string
          name: string
          source_generated_artifact_id: string | null
          type: DocumentType
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          created_at?: string
          file_path: string
          file_size?: number | null
          id?: string
          name: string
          source_generated_artifact_id?: string | null
          type: DocumentType
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          created_at?: string
          file_path?: string
          file_size?: number | null
          id?: string
          name?: string
          source_generated_artifact_id?: string | null
          type?: DocumentType
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      generated_artifacts: {
        Row: {
          application_id: string
          content: string
          created_at: string
          generator_version: string
          id: string
          prompt_used: string | null
          type: GeneratedArtifactType
          user_id: string
        }
        Insert: {
          application_id: string
          content: string
          created_at?: string
          generator_version?: string
          id?: string
          prompt_used?: string | null
          type: GeneratedArtifactType
          user_id: string
        }
        Update: {
          application_id?: string
          content?: string
          created_at?: string
          generator_version?: string
          id?: string
          prompt_used?: string | null
          type?: GeneratedArtifactType
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "generated_artifacts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          cover_letter_tone: string
          created_at: string
          default_resume_document_id: string | null
          full_name: string | null
          id: string
          linkedin_url: string | null
          onboarded: boolean
          phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cover_letter_tone?: string
          created_at?: string
          default_resume_document_id?: string | null
          full_name?: string | null
          id?: string
          linkedin_url?: string | null
          onboarded?: boolean
          phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cover_letter_tone?: string
          created_at?: string
          default_resume_document_id?: string | null
          full_name?: string | null
          id?: string
          linkedin_url?: string | null
          onboarded?: boolean
          phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_default_resume_document_id_fkey"
            columns: ["default_resume_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
